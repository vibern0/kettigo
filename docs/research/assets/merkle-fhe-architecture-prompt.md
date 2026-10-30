# Merkle + FHE architecture infographic

Generated with the built-in image generation tool. The final image was inspected for the separation of Merkle authentication, FHE interval computation, fixed-beneficiary payouts, and offchain archive responsibilities.

## Initial prompt

Use case: infographic-diagram.
Create one simple, precise technical architecture infographic for an engineering article about Kettigo's experimental Merkle + FHE prize pool. Landscape 3:2. Off-white background, dark charcoal typography, thin clean lines, restrained blue/green accents, flat diagram style, generous whitespace, no 3D or decorative illustrations, no logos. Large readable text. Title: "Prize checks without scanning every user". Subtitle: "Merkle snapshot + Zama FHE • research architecture".
Use two clearly labelled swimlanes: upper lane "Onchain contract + FHE", lower lane "Offchain proof archive + user".
Five clear numbered main blocks, left to right in a coherent flow:
1 "Deposit + admit" smaller label "Verified positive balance".
2 "Update encrypted sum tree" smaller label "Balance handles + authenticated hashes". Small tree illustration of four leaves merging to root.
3 "Close draw" smaller label "Freeze root + encrypted total" and "Generate encrypted ticket". Badge "O(1) close".
4 "Verify one user's proof" smaller label "Historical owner + balance + path". Badge "At most 32 levels".
5 "FHE check + payout" smaller formula "start ≤ ticket < start + balance" and smaller label "Prize or zero → fixed beneficiary".
Connect 1→2→3. Connect 3→4 with label "Saved draw snapshot". Connect 4→5.
In lower lane: one box "Event archive / indexer" with sublabel "Retain events • rebuild historical paths". An arrow from tree block 2 down to archive, labelled "Node + ownership events". A second small lower box "User: Check for a prize". Arrow from archive to user labelled "Historical Merkle proof". Arrow from user up to step4 labelled "Submit check transaction". From close block3 a small arrow down to archive labelled "Snapshot metadata" if clean routing possible.
Make lane crossing and arrow directions unambiguous. The archive supplies authenticated ciphertext-handle paths; it never decrypts balances, selects the winner, generates the encrypted ticket, or authorizes payouts. Merkle verification is ordinary contract computation; FHE handles secret interval sums and comparisons. Do not depict indexer as random generator or winner finder.
Bottom concise two-line footer: "No all-user scan • Contract verifies proofs • One check per user per draw" then "Depth-32 tree: finite 2^32 slots. Live throughput and 60-day retention still under validation."
No testing numbers, no claim of infinite capacity, no ZK or SNARK block, no private key symbols. Align diagram elements cleanly and avoid arrow overlaps. Text must be accurate and legible.

## Accuracy edits

Edit this technical architecture infographic. Preserve its overall layout, dimensions, styling, all arrows and all other text. Make exactly these corrections for technical accuracy:
1. In step 3 "Close draw", replace the green box text "Encrypted total and ticket (FHE ciphertexts)" with "Encrypted total + ticket (ciphertext handles)".
2. In step 4 "Verify one user's proof", replace the lower green box currently reading "FHE: compute user interval and compare with ticket (encrypted)" with a pale blue box reading "Reject invalid proofs and replayed checks". Keep "Merkle path verification (ordinary computation)" above it. This stage only authenticates the historical path; comparison belongs in step 5.
3. In step 5, replace the green box text "FHE comparison (encrypted values)" with "FHE interval sum + comparison (encrypted values)".
4. In the bottom footer use mathematical superscript "2³²" instead of "2^32".
Do not add text or blocks. Keep every label crisp and legible. This is an edit, not a new diagram.

## Footer edit

Edit only the small bottom footer line of this infographic. Replace that entire small line, including its poorly rendered mathematical superscript, with exactly: "Finite tree capacity. Live throughput and 60-day retention still under validation." Preserve absolutely everything else, including the bold footer above, all boxes, arrows, labels, colors and dimensions. Keep this replacement footer large enough to read clearly.
