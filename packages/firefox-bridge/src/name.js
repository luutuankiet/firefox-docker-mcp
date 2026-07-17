// Deterministic, DISPLAY-ONLY mnemonic derived from a public key.
// The shared secret alone establishes identity and suffices to connect; this
// name is purely a human-friendly, stable handle so both ends can eyeball that
// they match. It carries no security weight.
const ADJ = [
  'amber', 'brave', 'calm', 'clever', 'coral', 'cosmic', 'crisp', 'dawn',
  'deep', 'eager', 'fabled', 'fuzzy', 'gentle', 'golden', 'honest', 'ivory',
  'jolly', 'keen', 'lively', 'lucky', 'mellow', 'merry', 'misty', 'noble',
  'olive', 'plush', 'proud', 'quiet', 'rapid', 'ruby', 'sage', 'scarlet',
  'shy', 'silent', 'silver', 'sleek', 'snowy', 'solar', 'spry', 'stellar',
  'sunny', 'swift', 'teal', 'tidy', 'vivid', 'warm', 'witty', 'zesty'
];
const NOUN = [
  'otter', 'falcon', 'maple', 'harbor', 'comet', 'willow', 'badger', 'cedar',
  'heron', 'lynx', 'marlin', 'walrus', 'pine', 'raven', 'sable', 'tiger',
  'fox', 'koala', 'moth', 'newt', 'owl', 'panda', 'quail', 'robin',
  'seal', 'stork', 'swan', 'toad', 'viper', 'wren', 'yak', 'zebra',
  'beaver', 'bison', 'crane', 'dingo', 'egret', 'ferret', 'gecko', 'ibis',
  'jackal', 'kestrel', 'lemur', 'mink', 'ocelot', 'puma', 'ram', 'tapir'
];

export function nameFromPublicKey(publicKey) {
  const b = publicKey;
  const a = ADJ[b[0] % ADJ.length];
  const c = NOUN[b[1] % NOUN.length];
  const d = NOUN[(b[2] + 7) % NOUN.length];
  return `${a}-${c}-${d}`;
}
