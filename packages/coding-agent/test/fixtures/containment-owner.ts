import { writeFileSync } from "node:fs";
import { launchPidNamespaceOperation } from "../../src/core/kernel/process-containment.js";

const [readyPath, daemonPidPath, latePath] = process.argv.slice(2);
if (!readyPath || !daemonPidPath || !latePath) throw new Error("missing fixture paths");
const daemonCode = `
import os, signal, time
os.setsid()
signal.signal(signal.SIGTERM, signal.SIG_IGN)
if os.fork(): os._exit(0)
if os.fork(): os._exit(0)
open(${JSON.stringify(daemonPidPath)}, "w").write(open("/proc/self/stat").read().split()[0])
time.sleep(1)
open(${JSON.stringify(latePath)}, "w").write("late")
time.sleep(60)
`;
const rootCode = `
import subprocess, sys, time
subprocess.Popen([sys.executable, "-c", ${JSON.stringify(daemonCode)}])
time.sleep(60)
`;
const operation = await launchPidNamespaceOperation("python3", ["-c", rootCode], {});
writeFileSync(readyPath, String(operation.monitor.pid));
await new Promise(() => {});
