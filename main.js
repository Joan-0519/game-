/**
 * 蜜蜂移動：鍵盤方向鍵 + 菱形方向鍵（左往左、右往右）。
 * 依實際左右位移水平翻轉；移動範圍限於 .play-area。
 * 草莓／蔥／蜻蜓／兩朵花不擋路；其他 .sprite 障礙物 AABB 碰撞（若無則僅邊界）。
 * 碰到草莓：速度 +10（整場僅一次）；碰到蔥：速度 -5（整場僅一次）；碰到蜻蜓：回到起始位置。
 * 碰到兩朵花會在該花上方顯示 ok.png；兩朵都碰到後顯示「授粉成功」。
 * 蜜蜂 z-index 最高，不會被其他場上物件蓋住。
 * 基礎速度以約 60fps 一幀 12px 換算。
 * 音效：移動 click.mp3、蜻蜓 errorse.mp3、花 rightse.mp3、授粉完成 winse.mp3。
 */
(function () {
  const BASE_BEE_SPEED = 12;
  const INV_SQRT2 = 1 / Math.sqrt(2);
  const MOVE_CLICK_MS = 130;

  const sfx = {
    click: new Audio("click.mp3"),
    error: new Audio("errorse.mp3"),
    right: new Audio("rightse.mp3"),
    win: new Audio("winse.mp3"),
  };
  Object.values(sfx).forEach((a) => {
    a.preload = "auto";
  });

  /** @param {HTMLAudioElement} a */
  function playSfx(a) {
    try {
      a.currentTime = 0;
      void a.play();
    } catch (_) {
      /* 瀏覽器自動播放限制等 */
    }
  }

  const bee = document.getElementById("bee");
  const playArea = document.querySelector(".play-area");
  if (!bee || !playArea) return;

  const dragonfly = playArea.querySelector(".sprite--dragonfly");
  const berry = playArea.querySelector(".sprite--berry");
  const scallion = playArea.querySelector(".sprite--scallion");
  const flowerA = playArea.querySelector(".sprite--flower-a");
  const flowerB = playArea.querySelector(".sprite--flower-b");
  const pollenOkA = document.getElementById("pollen-ok-a");
  const pollenOkB = document.getElementById("pollen-ok-b");
  const pollenSuccess = document.getElementById("pollen-success");

  let strawberryBoostUsed = false;
  let scallionPenaltyUsed = false;
  let flowerPollinatedA = false;
  let flowerPollinatedB = false;

  /** @type {{ up: boolean; down: boolean; left: boolean; right: boolean }} */
  const keyboard = { up: false, down: false, left: false, right: false };
  /** @type {{ up: boolean; down: boolean; left: boolean; right: boolean }} */
  const pointer = { up: false, down: false, left: false, right: false };

  let beeX = 0;
  let beeY = 0;
  let lastTs = 0;
  let rafId = 0;
  let lastMoveClickAt = 0;

  /** @type {Element[]} */
  let obstacleEls = [];

  function refreshObstacles() {
    obstacleEls = [
      ...playArea.querySelectorAll(
        ".sprite:not(#bee):not(.sprite--dragonfly):not(.sprite--berry):not(.sprite--scallion):not(.sprite--flower-a):not(.sprite--flower-b)",
      ),
    ];
  }

  function getBeeSpeed() {
    let v = BASE_BEE_SPEED;
    if (strawberryBoostUsed) v += 10;
    if (scallionPenaltyUsed) v -= 5;
    return Math.max(1, v);
  }

  function isPressed(dir) {
    return keyboard[dir] || pointer[dir];
  }

  function getBounds() {
    const w = bee.offsetWidth;
    const h = bee.offsetHeight;
    const maxX = Math.max(0, playArea.clientWidth - w);
    const maxY = Math.max(0, playArea.clientHeight - h);
    return { maxX, maxY };
  }

  function clampPosition() {
    const { maxX, maxY } = getBounds();
    beeX = Math.min(maxX, Math.max(0, beeX));
    beeY = Math.min(maxY, Math.max(0, beeY));
  }

  function applyBeePosition() {
    bee.style.left = `${beeX}px`;
    bee.style.top = `${beeY}px`;
  }

  /**
   * @param {{ left: number; top: number; right: number; bottom: number }} a
   * @param {{ left: number; top: number; right: number; bottom: number }} b
   */
  function intersects(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function beeClientAt(x, y) {
    const pr = playArea.getBoundingClientRect();
    const w = bee.offsetWidth;
    const h = bee.offsetHeight;
    const left = pr.left + x;
    const top = pr.top + y;
    return { left, top, right: left + w, bottom: top + h };
  }

  function hitsDragonflyAt(x, y) {
    if (!dragonfly) return false;
    const br = beeClientAt(x, y);
    const dr = dragonfly.getBoundingClientRect();
    return intersects(br, dr);
  }

  function hitsBerryAt(x, y) {
    if (!berry) return false;
    const br = beeClientAt(x, y);
    const r = berry.getBoundingClientRect();
    return intersects(br, r);
  }

  function hitsScallionAt(x, y) {
    if (!scallion) return false;
    const br = beeClientAt(x, y);
    const r = scallion.getBoundingClientRect();
    return intersects(br, r);
  }

  function hitsFlowerAAt(x, y) {
    if (!flowerA) return false;
    const br = beeClientAt(x, y);
    const r = flowerA.getBoundingClientRect();
    return intersects(br, r);
  }

  function hitsFlowerBAt(x, y) {
    if (!flowerB) return false;
    const br = beeClientAt(x, y);
    const r = flowerB.getBoundingClientRect();
    return intersects(br, r);
  }

  function hitsObstacleAt(x, y) {
    const br = beeClientAt(x, y);
    for (let i = 0; i < obstacleEls.length; i += 1) {
      const r = obstacleEls[i].getBoundingClientRect();
      if (intersects(br, r)) return true;
    }
    return false;
  }

  /** 先嘗試斜向，再分軸滑入，避免與障礙物重疊 */
  function tryMove(stepX, stepY) {
    const nx = beeX + stepX;
    const ny = beeY + stepY;
    if (!hitsObstacleAt(nx, ny)) {
      beeX = nx;
      beeY = ny;
      return;
    }
    if (stepX !== 0 && !hitsObstacleAt(nx, beeY)) {
      beeX = nx;
      return;
    }
    if (stepY !== 0 && !hitsObstacleAt(beeX, ny)) {
      beeY = ny;
    }
  }

  /** @param {number} prevX */
  function updateBeeFacing(prevX) {
    const delta = beeX - prevX;
    if (delta > 0.2) bee.classList.remove("sprite--bee--face-left");
    else if (delta < -0.2) bee.classList.add("sprite--bee--face-left");
  }

  function resetBeeToStart() {
    refreshObstacles();
    beeX = 0;
    beeY = Math.max(0, (playArea.clientHeight - bee.offsetHeight) / 2);
    if (hitsObstacleAt(beeX, beeY)) {
      beeX = Math.max(0, playArea.clientWidth - bee.offsetWidth);
      beeY = Math.max(0, (playArea.clientHeight - bee.offsetHeight) / 2);
    }
    clampPosition();
    bee.classList.remove("sprite--bee--face-left");
    applyBeePosition();
  }

  function tick(ts) {
    const dt = lastTs ? ts - lastTs : 1000 / 60;
    lastTs = ts;
    const frameMs = 1000 / 60;
    const step = getBeeSpeed() * (dt / frameMs);

    let dx = 0;
    let dy = 0;
    if (isPressed("up")) dy -= 1;
    if (isPressed("down")) dy += 1;
    if (isPressed("left")) dx -= 1;
    if (isPressed("right")) dx += 1;

    if (dx !== 0 && dy !== 0) {
      dx *= INV_SQRT2;
      dy *= INV_SQRT2;
    }

    const prevBeeX = beeX;
    const prevBeeY = beeY;
    tryMove(dx * step, dy * step);
    clampPosition();

    const inputMove =
      isPressed("up") ||
      isPressed("down") ||
      isPressed("left") ||
      isPressed("right");
    const movedThisFrame = beeX !== prevBeeX || beeY !== prevBeeY;

    if (hitsDragonflyAt(beeX, beeY)) {
      playSfx(sfx.error);
      resetBeeToStart();
    } else {
      if (inputMove && movedThisFrame && ts - lastMoveClickAt >= MOVE_CLICK_MS) {
        lastMoveClickAt = ts;
        playSfx(sfx.click);
      }
      if (hitsBerryAt(beeX, beeY) && !strawberryBoostUsed) {
        strawberryBoostUsed = true;
      }
      if (hitsScallionAt(beeX, beeY) && !scallionPenaltyUsed) {
        scallionPenaltyUsed = true;
      }
      if (hitsFlowerAAt(beeX, beeY) && !flowerPollinatedA) {
        flowerPollinatedA = true;
        playSfx(sfx.right);
      }
      if (hitsFlowerBAt(beeX, beeY) && !flowerPollinatedB) {
        flowerPollinatedB = true;
        playSfx(sfx.right);
      }
      if (pollenOkA && flowerPollinatedA) pollenOkA.classList.add("pollen-ok--visible");
      if (pollenOkB && flowerPollinatedB) pollenOkB.classList.add("pollen-ok--visible");
      if (
        flowerPollinatedA &&
        flowerPollinatedB &&
        pollenSuccess &&
        !pollenSuccess.classList.contains("pollen-success--visible")
      ) {
        playSfx(sfx.win);
        pollenSuccess.hidden = false;
        pollenSuccess.classList.add("pollen-success--visible");
      }
      applyBeePosition();
      updateBeeFacing(prevBeeX);
    }

    rafId = requestAnimationFrame(tick);
  }

  /** @param {KeyboardEvent} e */
  function onKeyDown(e) {
    switch (e.code) {
      case "ArrowUp":
        keyboard.up = true;
        e.preventDefault();
        break;
      case "ArrowDown":
        keyboard.down = true;
        e.preventDefault();
        break;
      case "ArrowLeft":
        keyboard.left = true;
        e.preventDefault();
        break;
      case "ArrowRight":
        keyboard.right = true;
        e.preventDefault();
        break;
      default:
        break;
    }
  }

  /** @param {KeyboardEvent} e */
  function onKeyUp(e) {
    switch (e.code) {
      case "ArrowUp":
        keyboard.up = false;
        break;
      case "ArrowDown":
        keyboard.down = false;
        break;
      case "ArrowLeft":
        keyboard.left = false;
        break;
      case "ArrowRight":
        keyboard.right = false;
        break;
      default:
        break;
    }
  }

  function bindPad() {
    const buttons = document.querySelectorAll(".d-pad [data-dir]");
    buttons.forEach((btn) => {
      const dir = /** @type {HTMLElement} */ (btn).dataset.dir;
      if (!dir || pointer[dir] === undefined) return;

      btn.addEventListener("pointerdown", (e) => {
        pointer[dir] = true;
        try {
          btn.setPointerCapture(e.pointerId);
        } catch (_) {
          /* ignore */
        }
      });
      btn.addEventListener("pointerup", () => {
        pointer[dir] = false;
      });
      btn.addEventListener("pointercancel", () => {
        pointer[dir] = false;
      });
      btn.addEventListener("lostpointercapture", () => {
        pointer[dir] = false;
      });
    });
  }

  function startLoop() {
    resetBeeToStart();
    lastTs = 0;
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }

  function init() {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    bindPad();

    const ro = new ResizeObserver(() => {
      refreshObstacles();
      clampPosition();
      applyBeePosition();
    });
    ro.observe(playArea);

    const kickoff = () => {
      requestAnimationFrame(() => {
        refreshObstacles();
        if (bee.complete) startLoop();
        else bee.addEventListener("load", startLoop, { once: true });
      });
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", kickoff, { once: true });
    } else {
      kickoff();
    }
  }

  init();
})();
