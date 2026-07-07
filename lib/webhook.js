const crypto = require("crypto");

const DEFAULT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq/+l1WnlRrGSolDMA+A8
6rAhMbQGmQ2SapVcGM3zq8ANXjnhDWocMqfWcTd95btDydITa10kDvHzw9WQOqp2
MZI7ZyrfzJuz5nhTPCiJwTwnEtWft7nV14BYRDHvlfqPUaZ+1KR4OCaO/wWIk/rQ
L/TjY0M70gse8rlBkbo2a8rKhu69RQTRsoaf4DVhDPEeSeI5jVrRDGAMGL3cGuyY
6CLKGdjVEM78g3JfYOvDU/RvfqD7L89TZ3iN94jrmWdGz34JNlEI5hqK8dd7C5EF
BEbZ5jgB8s8ReQV8H+MkuffjdAj3ajDDX3DOJMIut1lBrUVD1AaSrGCKHooWoL2e
twIDAQAB
-----END PUBLIC KEY-----`;

let cachedPublicKey = DEFAULT_PUBLIC_KEY;

async function loadPublicKey() {
  try {
    const response = await fetch("https://api.kick.com/public/v1/public-key");
    const data = await response.json();
    if (response.ok && data.data?.public_key) {
      cachedPublicKey = data.data.public_key;
    }
  } catch {
    // Keep the bundled fallback key.
  }

  return cachedPublicKey;
}

function verifyKickWebhook(rawBody, headers) {
  const messageId = headers["kick-event-message-id"];
  const timestamp = headers["kick-event-message-timestamp"];
  const signature = headers["kick-event-signature"];

  if (!messageId || !timestamp || !signature) {
    return false;
  }

  const signedContent = `${messageId}.${timestamp}.${rawBody.toString()}`;

  try {
    return crypto.verify(
      "RSA-SHA256",
      Buffer.from(signedContent),
      cachedPublicKey,
      Buffer.from(signature, "base64")
    );
  } catch {
    return false;
  }
}

module.exports = {
  loadPublicKey,
  verifyKickWebhook,
};
