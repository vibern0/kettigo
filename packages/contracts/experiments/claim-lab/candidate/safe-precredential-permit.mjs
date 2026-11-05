function asBytes(value, label) {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > 1024) {
    throw new Error(`${label} must be bounded bytes`);
  }
  return new Uint8Array(value);
}

function equalBytes(left, right) {
  if (!(right instanceof Uint8Array) || left.length !== right.length) return false;
  const leftView = new DataView(left.buffer, left.byteOffset, left.byteLength);
  const rightView = new DataView(right.buffer, right.byteOffset, right.byteLength);
  let different = 0;
  for (let index = 0; index < left.length; index += 1) {
    different |= leftView.getUint8(index) ^ rightView.getUint8(index);
  }
  return different === 0;
}

function assertRequest(request, snapshot) {
  const publicKey = request?.publicKey;
  const allowed = publicKey?.allowCredentials;
  if (
    !publicKey ||
    !equalBytes(snapshot.challenge, publicKey.challenge) ||
    publicKey.rpId !== snapshot.rpId ||
    publicKey.userVerification !== snapshot.userVerification ||
    !Array.isArray(allowed) ||
    allowed.length !== 1 ||
    allowed[0]?.type !== "public-key" ||
    !equalBytes(snapshot.rawId, allowed[0]?.id)
  ) {
    throw new Error("credential request does not match permit");
  }
}

export function createPrecredentialPermit({
  reservationId,
  challenge,
  rawId,
  rpId,
  userVerification = "required",
  deadlineAt,
  now = Date.now,
  stopped = () => false,
  platform,
}) {
  if (
    typeof reservationId !== "string" ||
    reservationId.length === 0 ||
    typeof rpId !== "string" ||
    rpId.length === 0 ||
    typeof deadlineAt !== "number" ||
    !Number.isSafeInteger(deadlineAt) ||
    typeof now !== "function" ||
    typeof stopped !== "function" ||
    !platform ||
    typeof platform.createAbortController !== "function" ||
    typeof platform.setTimer !== "function" ||
    typeof platform.clearTimer !== "function"
  ) {
    throw new Error("invalid credential permit");
  }
  const snapshot = Object.freeze({
    reservationId,
    challenge: asBytes(challenge, "challenge"),
    rawId: asBytes(rawId, "raw credential id"),
    rpId,
    userVerification,
    deadlineAt,
  });
  let used = false;
  let controller;
  let deadlineTimer;

  function stop() {
    if (deadlineTimer !== undefined) platform.clearTimer(deadlineTimer);
    controller?.abort();
  }

  return Object.freeze({
    reservationId,
    start(request, nativeGet) {
      if (used) throw new Error("credential permit already used");
      if (stopped() || now() >= snapshot.deadlineAt)
        throw new Error("credential permit is unavailable");
      if (typeof nativeGet !== "function") throw new Error("native credential getter is required");
      assertRequest(request, snapshot);
      used = true;
      controller = platform.createAbortController();
      deadlineTimer = platform.setTimer(stop, snapshot.deadlineAt - now());
      const nativeRequest = {
        ...request,
        publicKey: { ...request.publicKey, signal: controller.signal },
      };
      return nativeGet(nativeRequest);
    },
    stop,
    async capture(assertion, capture) {
      if (!used || typeof capture !== "function")
        throw new Error("credential capture is unavailable");
      return capture(assertion);
    },
  });
}
