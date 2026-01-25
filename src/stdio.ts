let streamBroken = false;

function isEpipe(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as NodeJS.ErrnoException).code === "EPIPE";
}

function shouldSkipWrite(stream: NodeJS.WriteStream): boolean {
  if (streamBroken) {
    return true;
  }
  if (stream.destroyed || stream.writableEnded) {
    streamBroken = true;
    return true;
  }
  return !stream.writable;
}

function handleStreamError(error: NodeJS.ErrnoException): void {
  if (error.code === "EPIPE") {
    streamBroken = true;
    return;
  }
}

function wrapStreamWrite(stream: NodeJS.WriteStream): void {
  const originalWrite = stream.write.bind(stream);
  stream.write = ((...args: Parameters<NodeJS.WriteStream["write"]>): boolean => {
    if (shouldSkipWrite(stream)) {
      return false;
    }
    try {
      return originalWrite(...args);
    } catch (error) {
      if (isEpipe(error)) {
        streamBroken = true;
        return false;
      }
      throw error;
    }
  }) as NodeJS.WriteStream["write"];
  stream.on("error", handleStreamError);
}

wrapStreamWrite(process.stdout);
wrapStreamWrite(process.stderr);

process.on("uncaughtException", (error) => {
  if (isEpipe(error)) {
    streamBroken = true;
    return;
  }
  process.stderr.write(`Uncaught exception: ${error}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  if (isEpipe(reason)) {
    streamBroken = true;
    return;
  }
  process.stderr.write(`Unhandled rejection: ${reason}\n`);
  process.exit(1);
});
