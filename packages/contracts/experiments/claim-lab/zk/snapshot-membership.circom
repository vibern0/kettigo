pragma circom 2.2.3;
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";

// Attempt B: authenticate actual encrypted balances and sibling sums. Keep
// the winning comparison in FHE, so no plaintext opening bridge is assumed.
template SnapshotMembership(depth) {
    signal input rootHash;
    signal input rootLo;
    signal input rootHi;
    signal input scope;
    signal input account;
    signal input index;
    signal input balanceLo;
    signal input balanceHi;
    signal input siblingLo[depth];
    signal input siblingHi[depth];
    signal input siblingHash[depth];
    signal input parentLo[depth];
    signal input parentHi[depth];
    signal output nullifier;

    component bits = Num2Bits(depth);
    bits.in <== index;
    component accountBits = Num2Bits(160);
    accountBits.in <== account;
    component handleBits[4 * depth + 4];
    for (var i = 0; i < 4 * depth + 4; i++) handleBits[i] = Num2Bits(128);
    handleBits[0].in <== balanceLo;
    handleBits[1].in <== balanceHi;
    handleBits[2].in <== rootLo;
    handleBits[3].in <== rootHi;

    component leaf = Poseidon(3);
    leaf.inputs[0] <== account;
    leaf.inputs[1] <== balanceLo;
    leaf.inputs[2] <== balanceHi;
    signal h[depth + 1];
    signal lo[depth + 1];
    signal hi[depth + 1];
    h[0] <== leaf.out;
    lo[0] <== balanceLo;
    hi[0] <== balanceHi;
    component parents[depth];
    for (var i = 0; i < depth; i++) {
        handleBits[4 + 4*i].in <== siblingLo[i];
        handleBits[5 + 4*i].in <== siblingHi[i];
        handleBits[6 + 4*i].in <== parentLo[i];
        handleBits[7 + 4*i].in <== parentHi[i];
        parents[i] = Poseidon(6);
        parents[i].inputs[0] <== h[i] + bits.out[i] * (siblingHash[i] - h[i]);
        parents[i].inputs[1] <== lo[i] + bits.out[i] * (siblingLo[i] - lo[i]);
        parents[i].inputs[2] <== hi[i] + bits.out[i] * (siblingHi[i] - hi[i]);
        parents[i].inputs[3] <== siblingHash[i] + bits.out[i] * (h[i] - siblingHash[i]);
        parents[i].inputs[4] <== siblingLo[i] + bits.out[i] * (lo[i] - siblingLo[i]);
        parents[i].inputs[5] <== siblingHi[i] + bits.out[i] * (hi[i] - siblingHi[i]);
        h[i + 1] <== parents[i].out;
        lo[i + 1] <== parentLo[i];
        hi[i + 1] <== parentHi[i];
    }
    h[depth] === rootHash;
    lo[depth] === rootLo;
    hi[depth] === rootHi;
    component replay = Poseidon(2);
    replay.inputs[0] <== account;
    replay.inputs[1] <== scope;
    nullifier <== replay.out;
}

component main {public [rootHash, rootLo, rootHi, scope, account, index, balanceLo, balanceHi, siblingLo, siblingHi]} = SnapshotMembership(32);
