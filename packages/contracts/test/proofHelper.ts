/** Production-tree proof capture helper. Capture before the draw is closed. */
export async function captureMembershipProof(pool: any, account: string) {
  const position = await pool.membershipIndexOf(account);
  const index = position - 1n;
  const generation = await pool.generationOf(index);
  const [, balance] = await pool.membershipNode(0, index);
  const siblingHashes: string[] = [],
    siblingSums: string[] = [],
    parentSums: string[] = [];
  for (let level = 0n; level < 32n; level++) {
    const [hash, sum] = await pool.membershipNode(level, (index >> level) ^ 1n);
    const [, parent] = await pool.membershipNode(level + 1n, index >> (level + 1n));
    siblingHashes.push(hash);
    siblingSums.push(sum);
    parentSums.push(parent);
  }
  return { index, generation, balance, siblingHashes, siblingSums, parentSums };
}

export async function checkCapturedPrize(pool: any, drawId: bigint, account: string, proof: any) {
  return pool.checkPrize(
    drawId,
    account,
    proof.index,
    proof.generation,
    proof.balance,
    proof.siblingHashes,
    proof.siblingSums,
    proof.parentSums,
  );
}
