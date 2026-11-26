import Hls from 'hls.js';

export function attachPlayback(element, media, onError, HlsPlayer = Hls) {
    let hls;
    if (media.kind === 'video' && media.stream === 'hls' && HlsPlayer.isSupported()) {
        hls = new HlsPlayer({ enableWorker: false, maxBufferLength: 10, maxMaxBufferLength: 20, backBufferLength: 10 });
        hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
            if (data.fatal)
                onError('The video stream could not be loaded. Retry to refresh its link.');
        });
        hls.attachMedia(element);
        hls.loadSource(media.url);
    } else if (media.stream === 'hls' && !element.canPlayType('application/vnd.apple.mpegurl')) {
        onError('Video streaming is unavailable in this Steam session. Try opening it in your browser.');
    } else {
        element.src = media.url;
    }
    return () => {
        hls?.destroy();
        element.pause();
        element.removeAttribute('src');
        element.load();
    };
}
