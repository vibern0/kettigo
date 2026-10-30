pragma circom 2.2.3;
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

// Attempt A: real proof of committed range ownership. The experiment tests
// whether this statement also proves the range was funded by a Zama receipt.
template RangeClaim(depth) {
    signal input root;
    signal input scope;
    signal input account;
    signal input receiptLo;
    signal input receiptHi;
    signal input ticket;
    signal input total;
    signal input start;
    signal input end;
    signal input secret;
    signal input index;
    signal input siblings[depth];
    signal output nullifier;

    component accountBits = Num2Bits(160);
    accountBits.in <== account;
    component loBits = Num2Bits(128);
    loBits.in <== receiptLo;
    component hiBits = Num2Bits(128);
    hiBits.in <== receiptHi;
    component values[4];
    for (var i = 0; i < 4; i++) values[i] = Num2Bits(64);
    values[0].in <== start;
    values[1].in <== end;
    values[2].in <== ticket;
    values[3].in <== total;
    component lower = LessEqThan(64);
    lower.in[0] <== start;
    lower.in[1] <== ticket;
    lower.out === 1;
    component upper = LessThan(64);
    upper.in[0] <== ticket;
    upper.in[1] <== end;
    upper.out === 1;
    component bound = LessEqThan(64);
    bound.in[0] <== end;
    bound.in[1] <== total;
    bound.out === 1;

    component range = Poseidon(3);
    range.inputs[0] <== start;
    range.inputs[1] <== end;
    range.inputs[2] <== secret;
    component leaf = Poseidon(4);
    leaf.inputs[0] <== account;
    leaf.inputs[1] <== receiptLo;
    leaf.inputs[2] <== receiptHi;
    leaf.inputs[3] <== range.out;
    component bits = Num2Bits(depth);
    bits.in <== index;
    signal hashes[depth + 1];
    hashes[0] <== leaf.out;
    component parents[depth];
    for (var i = 0; i < depth; i++) {
        parents[i] = Poseidon(2);
        parents[i].inputs[0] <== hashes[i] + bits.out[i] * (siblings[i] - hashes[i]);
        parents[i].inputs[1] <== siblings[i] + bits.out[i] * (hashes[i] - siblings[i]);
        hashes[i + 1] <== parents[i].out;
    }
    root === hashes[depth];
    component replay = Poseidon(2);
    replay.inputs[0] <== secret;
    replay.inputs[1] <== scope;
    nullifier <== replay.out;
}

component main {public [root, scope, account, receiptLo, receiptHi, ticket, total]} = RangeClaim(8);
