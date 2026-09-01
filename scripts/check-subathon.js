const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subathon-"));
process.env.DATA_DIR = dir;

const subathon = require("../lib/stream-subathon-state");

function assert(cond, label) {
  if (!cond) throw new Error(label);
}

assert(subathon.parseCommand("!subathon")?.action === "show", "show");
assert(subathon.parseCommand("!subathon start")?.action === "start", "start");
assert(subathon.parseCommand("!subathon start 300")?.action === "seed", "start 300 seeds");
assert(subathon.parseCommand("!subathon start 300")?.count === 300, "seed count");
assert(subathon.parseCommand("!subathon seed 300")?.action === "seed", "seed alias");
assert(subathon.parseCommand("!subathon +10")?.minutes === 10, "add minutes");
assert(subathon.parseCommand("!subathon 3")?.count === 3, "add subs");
assert(subathon.parseCommand("hello") === null, "ignore other chat");

subathon.applyAction({ action: "reset" });
const started = subathon.loadForDisplay();
assert(started.isRunning, "reset starts the clock");
assert(started.count === 0, "reset clears subs");

const added = subathon.applyAction({ action: "add", count: 2, by: "coco" });
assert(added.state.count === 2, "two subs counted");
assert(added.state.lastSubBy === "coco", "last sub name");
assert(added.state.remainingSeconds > started.remainingSeconds, "subs add time");

const seeded = subathon.applyAction({ action: "seed", count: 300, by: "gifter" });
assert(seeded.state.count === 300, "seeded 300 subs");
assert(seeded.state.lastSubBy === "gifter", "seed keeps the gifter");
assert(
  seeded.state.remainingSeconds === 300 * seeded.state.secondsPerSub,
  "clock opens on 300 × min/sub"
);
assert(seeded.state.displayTime === "25:00:00", "300 × 5 min is 25 hours");

console.log("subathon check passed");
