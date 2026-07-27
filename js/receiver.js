'use strict';

const NAMESPACE = 'urn:x-cast:io.music-assistant.cast';

// Sent to the server when the device's own UI asks for a queue jump.
const PLAYER_COMMAND_TYPE = 'player_command';

// Mirrors CAF's built-in ~5 min idle-application timeout, replicated below.
const IDLE_SHUTDOWN_SEC = 300;

const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();

const mediaPlayerEl = document.querySelector('cast-media-player');
const dashboardFrameEl = document.getElementById('dashboard-frame');

let idleShutdownTimer = null;

// update metadata
function updateMetadata(metaData){
  try {
    // retrieve current media information
    const mediaInformation = playerManager.getMediaInformation()
    // update its metadata
    mediaInformation.metadata = metaData
    // update current media information
    playerManager.setMediaInformation(mediaInformation)
  } catch(err){
    console.warn("updateMetadata error", err)
  }
}

// With disableIdleTimeout we must shut down idle audio-only sessions ourselves
// to keep behavior parity with the stock receiver; a visible dashboard keeps
// the session alive indefinitely. Like the stock timeout, we only shut down
// once no sender is connected - a connected sender keeps the session alive.
function updateIdleShutdownTimer() {
  const dashboardActive = !dashboardFrameEl.hidden;
  const playerIdle =
    playerManager.getPlayerState() === cast.framework.messages.PlayerState.IDLE;
  const senderConnected = context.getSenders().length > 0;
  if (!dashboardActive && playerIdle && !senderConnected) {
    if (idleShutdownTimer === null) {
      idleShutdownTimer = setTimeout(() => context.stop(), IDLE_SHUTDOWN_SEC * 1000);
    }
  } else if (idleShutdownTimer !== null) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }
}

// A silent looping video held in PLAYING stops smart displays from deactivating
// the app or handing the screen to ambient mode (paused/audio-only media don't).
const KEEPALIVE_INTERVAL_SEC = 120;
const KEEPALIVE_CONTENT_ID = location.origin + '/dashboard-keepalive.mp4';
let keepaliveTimer = null;

function playKeepaliveMedia() {
  const loadRequest = new cast.framework.messages.LoadRequestData();
  loadRequest.autoplay = true;
  loadRequest.media = new cast.framework.messages.MediaInformation();
  loadRequest.media.contentId = KEEPALIVE_CONTENT_ID;
  loadRequest.media.contentType = 'video/mp4';
  loadRequest.media.streamType = cast.framework.messages.StreamType.BUFFERED;
  const metadata = new cast.framework.messages.GenericMediaMetadata();
  metadata.title = 'Music Assistant';
  loadRequest.media.metadata = metadata;
  loadRequest.queueData = new cast.framework.messages.QueueData();
  loadRequest.queueData.repeatMode = cast.framework.messages.RepeatMode.REPEAT_SINGLE;
  loadRequest.requestId = 0;
  playerManager.load(loadRequest);
}

function keepaliveTick() {
  // real playback already keeps the app active - never clobber it
  const info = playerManager.getMediaInformation();
  const isKeepalive = !!info && info.contentId === KEEPALIVE_CONTENT_ID;
  const state = playerManager.getPlayerState();
  if (isKeepalive && state === cast.framework.messages.PlayerState.PLAYING) return;
  if (!isKeepalive && state !== cast.framework.messages.PlayerState.IDLE) return;
  playKeepaliveMedia();
}

function startKeepalive() {
  const capabilities = context.getDeviceCapabilities();
  // only touch displays (Nest Hub) deactivate idle apps
  if (!capabilities || !capabilities.touch_input_supported) return;
  if (keepaliveTimer !== null) return;
  keepaliveTick();
  keepaliveTimer = setInterval(keepaliveTick, KEEPALIVE_INTERVAL_SEC * 1000);
}

function stopKeepalive() {
  if (keepaliveTimer !== null) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  const info = playerManager.getMediaInformation();
  if (info && info.contentId === KEEPALIVE_CONTENT_ID) {
    playerManager.stop();
  }
}

// hand the screen back to the regular media UI (audio keeps playing)
function hideDashboard() {
  if (dashboardFrameEl.hidden) return;
  dashboardFrameEl.hidden = true;
  // about:blank, not '': an empty src reloads the receiver page inside the iframe
  dashboardFrameEl.src = 'about:blank';
  mediaPlayerEl.hidden = false;
  document.body.classList.remove('dashboard-active');
  stopKeepalive();
  updateIdleShutdownTimer();
}

// show the MA dashboard fullscreen and hide the audio media player
function showDashboard({ url }) {
  dashboardFrameEl.src = url;
  dashboardFrameEl.hidden = false;
  mediaPlayerEl.hidden = true;
  // drives the CSS that keeps the media player UI hidden when media loads
  document.body.classList.add('dashboard-active');
  startKeepalive();
  updateIdleShutdownTimer();
}


context.addCustomMessageListener(NAMESPACE, event => {
  const message = event.data;
  if (!message) return;
  // never log the full message: show_dashboard carries a one-time auth code
  console.log("MSG:" + message.type)
  if (message.type === 'show_dashboard') {
    if (!message.url) return;
    showDashboard(message);
    context.sendCustomMessage(NAMESPACE, event.senderId, {
      type: 'receiver_status',
      connected: true,
    });
  } else if (message.type === 'hide_dashboard') {
    hideDashboard();
    context.sendCustomMessage(NAMESPACE, event.senderId, {
      type: 'receiver_status',
      connected: true,
    });
  }
});

// Sender GET_PLAY request
playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.PLAY, data => {
    console.log("MSG:PLAY", data)
    // update Player metadata with data.customData.metadata if any
    if (data && data.customData && data.customData.metadata)
      updateMetadata(data.customData.metadata)
    return data
  }
)

// Next/previous arrive as a QUEUE_UPDATE jump (QUEUE_NEXT/QUEUE_PREV are not
// interceptable); MA owns the queue, so forward and stop CAF touching its own.
playerManager.setMessageInterceptor(
  cast.framework.messages.MessageType.QUEUE_UPDATE, data => {
    if (!data || typeof data.jump !== 'number' || data.jump === 0) return data;
    context.sendCustomMessage(NAMESPACE, undefined, {
      type: PLAYER_COMMAND_TYPE,
      command: data.jump > 0 ? 'next' : 'previous',
    });
    return null;
  }
)

// Audio and dashboard coexist in one session: a LOAD while a dashboard is
// shown plays behind it (the dashboard renders the now-playing state itself);
// the media player UI is only visible when no dashboard is active.

// re-evaluate the idle shutdown on every player state change
playerManager.addEventListener(
  cast.framework.events.EventType.MEDIA_STATUS,
  () => updateIdleShutdownTimer()
);

// a sender (dis)connecting also changes whether we may idle-shut-down
context.addEventListener(
  cast.framework.system.EventType.SENDER_CONNECTED,
  () => updateIdleShutdownTimer()
);
context.addEventListener(
  cast.framework.system.EventType.SENDER_DISCONNECTED,
  () => updateIdleShutdownTimer()
);

const options = new cast.framework.CastReceiverOptions();
// The built-in idle timeout would kill long-running dashboard sessions; we
// disable it and replicate the idle shutdown ourselves for audio-only sessions.
options.disableIdleTimeout = true;
// Without these bits the Cast UI draws no next/previous button and the SDK
// rejects jump requests before they reach our interceptor.
options.supportedCommands =
  cast.framework.messages.Command.ALL_BASIC_MEDIA |
  cast.framework.messages.Command.QUEUE_NEXT |
  cast.framework.messages.Command.QUEUE_PREV;
options.customNamespaces = { [NAMESPACE]: cast.framework.system.MessageType.JSON };
context.start(options);
updateIdleShutdownTimer();
