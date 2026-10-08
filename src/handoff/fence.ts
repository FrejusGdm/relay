// The fence around agent-written text in checkpoint.md (add-relay-switch, design decision 11;
// docs/research/security.md section 5, recommendation 1). Its marker is 8 random hexadecimal
// characters that the text does not contain, so nothing inside can close the fence early.
import { randomBytes } from "node:crypto";

const DRAWS = 5;

interface Fence {
  nonce: string;
  open: string;
  close: string;
}

export function drawFence(text: string, random: () => string = () => randomBytes(4).toString("hex")): Fence {
  for (let draw = 0; draw < DRAWS; draw++) {
    const nonce = random();
    if (!text.includes(nonce)) return { nonce, open: `<<<relay-untrusted-notes-${nonce}`, close: `relay-untrusted-notes-${nonce}>>>` };
  }
  throw new Error(`relay drew ${DRAWS} fence markers and the notes contained each of them.`);
}
