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

console.log("subathon check passed");
