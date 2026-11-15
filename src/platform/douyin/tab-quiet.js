// ============================================================
// 常驻监听标签页的「安静模式」
// ------------------------------------------------------------
// 私信监听、回评论都是后台常驻页，不该顺手播视频。
// 这段脚本同时用于「新文档注入」和「当前页面立即执行」：
// 先把已有的 video 暂停/静音，再拦住之后自动播放或推荐流换条挂上来的 video。
// 两个监听器共用同一份，避免一处改了、另一处还在旧行为。
// ============================================================

export const PAUSE_VIDEOS_JS = `(() => {
  const pause = (v) => {
    try {
      v.autoplay = false;
      v.muted = true;
      if (!v.paused) v.pause();
    } catch {}
  };
  const scan = () => {
    let n = 0;
    for (const v of document.querySelectorAll('video')) { pause(v); n += 1; }
    return n;
  };
  // 捕获阶段拦 play：autoplay / 用户点开 / 推荐流换条都在这里按掉
  if (!window.__fishTabQuietPlay) {
    window.__fishTabQuietPlay = true;
    document.addEventListener('play', (e) => {
      if (e.target && e.target.tagName === 'VIDEO') pause(e.target);
    }, true);
  }
  // 新 video 是后来插入的，play 事件不一定经过 document，定时补一刀
  if (!window.__fishTabQuietTimer) {
    window.__fishTabQuietTimer = setInterval(scan, 1500);
  }
  return scan();
})()`
