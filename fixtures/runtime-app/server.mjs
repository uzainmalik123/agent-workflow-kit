import { createServer } from "node:http";

/**
 * The smallest application that can be verified at runtime, and the one the end-to-end test drives.
 *
 * It exists to be started, probed, and stopped by `fixtures/runtime-app/agent-workflow.config.json`,
 * which is the whole contract: a command, a readiness condition, and two criteria. There is no test
 * framework, no build step, and no dependency, so a failure in the end-to-end run can only be a failure
 * of the framework or of this file.
 *
 * The port arrives as an argument rather than through the environment. The framework passes no
 * environment of its own, and a fixture that needed one would be measuring something the configuration
 * does not declare.
 */
const port = Number(process.argv[2]);

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }

  response.writeHead(200, { "content-type": "text/html" }).end(
    "<!doctype html><title>Dashboard</title><h1>Dashboard</h1>",
  );
});

server.listen(port, "127.0.0.1");

// A server that is asked to stop leaves nothing behind: the socket is closed, and the process is left
// to exit. A test that finds the port still bound is looking at a process that ignored its shutdown,
// which is the failure this whole stage exists to notice.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
