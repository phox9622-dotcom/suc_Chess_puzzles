const SDK = "https://cdn.jsdelivr.net/npm/@pollen-robotics/reachy-mini-sdk@1.12.0";
const CHESS_URL = "https://esm.sh/chess.js@1.0.0";
const GLYPHS = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const FILES = "abcdefgh";
const GENERATION_BUDGET_MS = 5000;

const plain = (m) => ({ from: m.from, to: m.to, promotion: m.promotion });

function matingMoves(chess) {
  return chess.moves({ verbose: true }).filter((m) => {
    chess.move(plain(m));
    const mate = chess.isCheckmate();
    chess.undo();
    return mate;
  });
}

function forcedMateFirstMoves(chess) {
  const firsts = [];
  for (const m of chess.moves({ verbose: true })) {
    if (!m.san.endsWith("+")) continue;
    chess.move(plain(m));
    const replies = chess.isGameOver() ? [] : chess.moves({ verbose: true });
    let forced = replies.length > 0;
    for (const r of replies) {
      if (!forced) break;
      chess.move(plain(r));
      forced = matingMoves(chess).length > 0;
      chess.undo();
    }
    chess.undo();
    if (forced) firsts.push(m.from + m.to);
  }
  return firsts;
}

function randomPosition(Chess) {
  const chess = new Chess();
  const plies = 30 + Math.floor(Math.random() * 60);
  for (let i = 0; i < plies; i++) {
    const moves = chess.moves();
    if (!moves.length) return null;
    chess.move(moves[Math.floor(Math.random() * moves.length)]);
  }
  return chess.isGameOver() || chess.isCheck() ? null : chess;
}

async function generatePuzzle(Chess, mode, isCancelled) {
  const deadline = performance.now() + GENERATION_BUDGET_MS;
  while (!isCancelled()) {
    const outOfTime = performance.now() > deadline;
    if (outOfTime && mode === 2) return generatePuzzle(Chess, 1, isCancelled).then((p) => p && { ...p, fellBack: true });
    const chess = randomPosition(Chess);
    if (chess) {
      const mates = matingMoves(chess);
      if (mode === 1 && mates.length === 1 && chess.moves().length >= 8) {
        return { fen: chess.fen(), mode: 1, firsts: new Set(mates.map((m) => m.from + m.to)) };
      }
      if (mode === 2 && mates.length === 0) {
        const firsts = forcedMateFirstMoves(chess);
        if (firsts.length >= 1 && firsts.length <= 3) return { fen: chess.fen(), mode: 2, firsts: new Set(firsts) };
      }
    }
    await new Promise((r) => setTimeout(r));
  }
  return null;
}

function renderApp(app, handle, { rpyToMatrix, degToRad, Chess }) {
  const robot = handle?.reachy;
  app.innerHTML = `
    <div class="bar">
      <select id="mode">
        <option value="1">Mate in 1</option>
        <option value="2">Mate in 2</option>
      </select>
      <button class="btn" id="new">New puzzle</button>
      <button class="btn" id="hint">Hint</button>
    </div>
    <div id="status">Generating…</div>
    <div id="board"></div>
    <div id="score">Solved: 0</div>
  `;
  
  const boardEl = app.querySelector("#board");
  const statusEl = app.querySelector("#status");
  const scoreEl = app.querySelector("#score");
  const modeEl = app.querySelector("#mode");
  
  let chess = new Chess();
  let puzzle = null;
  let playerColor = "w";
  let stage = 0;
  let selected = null;
  let hintSquare = null;
  let busy = true;
  let solved = 0;
  let generationId = 0;
  let timers = [];
  
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  
  const moveHead = (steps) => {
    if (!robot) return;
    steps.forEach(([roll, pitch, yaw, antennas], i) => {
      later(() => {
        try {
          robot.gotoTarget({
            head: rpyToMatrix(roll, pitch, yaw).flat(),
            antennas: antennas.map(degToRad),
            duration: 0.3,
          });
        } catch (err) {
          console.error(err);
        }
      }, i * 350);
    });
  };
  
  const celebrate = () => moveHead([[0, 15, 0, [40, -40]], [0, -10, 0, [-40, 40]], [0, 15, 0, [40, -40]], [0, 0, 0, [-10, 10]]]);
  const shake = () => moveHead([[0, 0, 20, [-10, 10]], [0, 0, -20, [-10, 10]], [0, 0, 15, [-10, 10]], [0, 0, 0, [-10, 10]]]);
  
  const legalTargets = () =>
    selected ? chess.moves({ square: selected, verbose: true }).map((m) => m.to) : [];
    
  function draw() {
    const targets = legalTargets();
    const rows = chess.board();
    const flip = playerColor === "b";
    const cells = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const rr = flip ? 7 - r : r;
        const cc = flip ? 7 - c : c;
        const piece = rows[rr][cc];
        const square = FILES[cc] + (8 - rr);
        const cls = ["sq", (rr + cc) % 2 ? "dark" : "light"];
        if (square === selected) cls.push("sel");
        if (square === hintSquare) cls.push("hint");
        if (targets.includes(square)) cls.push("target");
        const glyph = piece ? GLYPHS[piece.type] : "";
        const colorStyle = piece ? (piece.color === "w" ? "color:#fff;text-shadow:0 0 2px #000,0 0 2px #000;" : "color:#000;") : "";
        cells.push(`<button class="${cls.join(" ")}" data-sq="${square}" style="${colorStyle}">${glyph}</button>`);
      }
    }
    boardEl.innerHTML = cells.join("");
  }
  
  function say(text) {
    statusEl.textContent = text;
  }
  
  async function newPuzzle() {
    const id = ++generationId;
    busy = true;
    selected = null;
    hintSquare = null;
    say(modeEl.value === "2" ? "Generating a mate-in-2 puzzle (a few seconds)…" : "Generating…");
    await new Promise((r) => setTimeout(r, 30));
    const result = await generatePuzzle(Chess, Number(modeEl.value), () => id !== generationId);
    if (!result || id !== generationId) return;
    puzzle = result;
    chess = new Chess(result.fen);
    playerColor = chess.turn();
    stage = 0;
    busy = false;
    const side = playerColor === "w" ? "White" : "Black";
    const note = result.fellBack ? " (no mate-in-2 found in time, here's a mate in 1)" : "";
    say(`${side} to move: ${result.mode === 1 ? "checkmate in 1" : "checkmate in 2"}${note}`);
    draw();
  }
  
  function win() {
    solved++;
    scoreEl.textContent = `Solved: ${solved}`;
    say("Checkmate! You win 🎉");
    busy = true;
    celebrate();
    draw();
  }
  
  function attempt(from, to) {
    const legal = chess.moves({ square: from, verbose: true }).find((m) => m.to === to);
    selected = null;
    if (!legal) return draw();
    chess.move({ from, to, promotion: "q" });
    const key = from + to;
    if (chess.isCheckmate()) return win();
    if (puzzle.mode === 2 && stage === 0 && puzzle.firsts.has(key)) {
      stage = 1;
      busy = true;
      say("Good! Opponent replies…");
      draw();
      later(() => {
        const replies = chess.moves();
        chess.move(replies[Math.floor(Math.random() * replies.length)]);
        busy = false;
        say("Now deliver checkmate!");
        draw();
      }, 600);
      return;
    }
    chess.undo();
    say("Not quite — try again");
    shake();
    draw();
  }
  
  boardEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".sq");
    if (!btn || busy || !puzzle) return;
    const square = btn.dataset.sq;
    hintSquare = null;
    if (selected && legalTargets().includes(square)) return attempt(selected, square);
    const piece = chess.get(square);
    selected = piece && piece.color === playerColor ? square : null;
    draw();
  });
  
  app.querySelector("#new").addEventListener("click", newPuzzle);
  modeEl.addEventListener("change", newPuzzle);
  
  app.querySelector("#hint").addEventListener("click", () => {
    if (busy || !puzzle) return;
    const key = puzzle.mode === 2 && stage === 0 ? [...puzzle.firsts][0] : matingMoves(chess)[0]?.from;
    hintSquare = key?.slice(0, 2) ?? null;
    draw();
  });
  
  newPuzzle();
  
  return () => {
    generationId++;
    timers.forEach(clearTimeout);
    timers = [];
  };
}

const params = new URLSearchParams(location.search);
const isEmbed = params.get("embedded") === "1" || location.hash.includes("creds=");

if (isEmbed) {
  try {
    const [{ connectToHost }, { safelyReturnToPose }, math, { Chess }] = await Promise.all([
      import(`${SDK}/host/dist/entry/embed.js`),
      import(`${SDK}/dist/animation/index.js`),
      import(`${SDK}/+esm`),
      import(CHESS_URL),
    ]);
    const handle = await connectToHost();
    document.getElementById("root")?.remove();
    const app = document.getElementById("app");
    app.hidden = false;
    const cleanup = renderApp(app, handle, { ...math, Chess });
    const applyTheme = (mode) =>
      document.documentElement.setAttribute("data-theme", mode === "dark" ? "dark" : "light");
    applyTheme(handle.theme);
    handle.onThemeChange(applyTheme);
    handle.onLeave(() => {
      try { cleanup(); } catch (err) { console.error(err); }
      handle.reachy.stopMove();
      safelyReturnToPose(handle.reachy);
    });
  } catch (e) {
    console.error("Failed to load Reachy SDK, falling back to standalone mode", e);
    startStandalone();
  }
} else {
  startStandalone();
}

async function startStandalone() {
  document.getElementById("root")?.remove();
  const app = document.getElementById("app");
  app.hidden = false;
  
  const { Chess } = await import(CHESS_URL);
  
  const mockHandle = {
    reachy: null,
    theme: 'light',
    onThemeChange: () => {},
    onLeave: () => {}
  };
  
  const mockMath = {
    rpyToMatrix: () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
    degToRad: (deg) => deg * (Math.PI / 180)
  };

  renderApp(app, mockHandle, { ...mockMath, Chess });
}
