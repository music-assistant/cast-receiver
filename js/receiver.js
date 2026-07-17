'use strict';

const NAMESPACE = 'urn:x-cast:io.music-assistant.cast';

// Mirrors CAF's built-in ~5 min idle-application timeout, replicated below.
const IDLE_SHUTDOWN_SEC = 300;

const context = cast.framework.CastReceiverContext.getInstance();
const playerManager = context.getPlayerManager();

const mediaPlayerEl = document.querySelector('cast-media-player');
const dashboardFrameEl = document.getElementById('dashboard-frame');

let idleShutdownTimer = null;

// helper : query elements even deeply within shadow doms
function querySelectorDeep(selector, root = document) {
  let currentRoot = root;
  let partials = selector.split('::shadow');
  let elems = currentRoot.querySelectorAll(partials[0]);
  for (let i = 1; i < partials.length; i++) {
    let partial = partials[i];
    let elemsInside = [];
    for (let j = 0; j < elems.length; j++) {
      let shadow = elems[j].shadowRoot;
      if (shadow) {
        const matchesInShadow = shadow.querySelectorAll(partial);
        elemsInside = elemsInside.concat([... matchesInShadow]);
      }
    }
    elems = elemsInside;
  }
  return elems;
}

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
// the session alive indefinitely.
function updateIdleShutdownTimer() {
  const dashboardActive = !dashboardFrameEl.hidden;
  const playerIdle =
    playerManager.getPlayerState() === cast.framework.messages.PlayerState.IDLE;
  if (!dashboardActive && playerIdle) {
    if (idleShutdownTimer === null) {
      idleShutdownTimer = setTimeout(() => context.stop(), IDLE_SHUTDOWN_SEC * 1000);
    }
  } else if (idleShutdownTimer !== null) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }
}

// Smart displays deactivate apps without media activity after ~10 minutes,
// independent of disableIdleTimeout. While a dashboard is shown without real
// playback, (re)loading a lightweight local image as media every 9 minutes
// keeps the app active - same approach as the Home Assistant cast receiver.
const KEEPALIVE_INTERVAL_SEC = 540;
const KEEPALIVE_CONTENT_ID = location.origin + '/keepalive.png';
let keepaliveTimer = null;

function playKeepaliveMedia() {
  const loadRequest = new cast.framework.messages.LoadRequestData();
  loadRequest.autoplay = true;
  loadRequest.media = new cast.framework.messages.MediaInformation();
  loadRequest.media.contentId = KEEPALIVE_CONTENT_ID;
  loadRequest.media.contentType = 'image/png';
  loadRequest.media.streamType = cast.framework.messages.StreamType.NONE;
  const metadata = new cast.framework.messages.GenericMediaMetadata();
  metadata.title = 'Music Assistant';
  loadRequest.media.metadata = metadata;
  loadRequest.requestId = 0;
  playerManager.load(loadRequest);
}

function keepaliveTick() {
  // real playback already keeps the app active - never clobber it
  const info = playerManager.getMediaInformation();
  const isKeepalive = !!info && info.contentId === KEEPALIVE_CONTENT_ID;
  const playerIdle =
    playerManager.getPlayerState() === cast.framework.messages.PlayerState.IDLE;
  if (!playerIdle && !isKeepalive) return;
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
  dashboardFrameEl.src = '';
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

// Audio and dashboard coexist in one session: a LOAD while a dashboard is
// shown plays behind it (the dashboard renders the now-playing state itself);
// the media player UI is only visible when no dashboard is active.

// re-evaluate the idle shutdown on every player state change
playerManager.addEventListener(
  cast.framework.events.EventType.MEDIA_STATUS,
  () => updateIdleShutdownTimer()
);

const options = new cast.framework.CastReceiverOptions();
// The built-in idle timeout would kill long-running dashboard sessions; we
// disable it and replicate the idle shutdown ourselves for audio-only sessions.
options.disableIdleTimeout = true;
options.customNamespaces = { [NAMESPACE]: cast.framework.system.MessageType.JSON };
context.start(options);
updateIdleShutdownTimer();
