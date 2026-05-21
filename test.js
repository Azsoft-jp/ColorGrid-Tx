const isBlack = (x) => {
  // margin 20px (0-19) -> white
  if (x < 20) return false;
  // finder row 3: 5B, 5W, 15B, 5W, 5B
  if (x >= 20 && x < 25) return true;
  if (x >= 25 && x < 30) return false;
  if (x >= 30 && x < 45) return true;
  if (x >= 45 && x < 50) return false;
  if (x >= 50 && x < 55) return true;
  return false;
}

const checkRatio = (counts) => {
    const total = counts.reduce((a, b) => a + b, 0);
    if (total < 7) return false;
    const moduleSize = total / 7;
    const maxVariance = moduleSize * 1.2;

    return Math.abs(moduleSize - counts[0]) < maxVariance &&
           Math.abs(moduleSize - counts[1]) < maxVariance &&
           Math.abs(3 * moduleSize - counts[2]) < maxVariance * 3 &&
           Math.abs(moduleSize - counts[3]) < maxVariance &&
           Math.abs(moduleSize - counts[4]) < maxVariance;
}

const width = 100;
let stateCounts = [0, 0, 0, 0, 0];
let currentState = 0;
const centers = [];

for (let x = 0; x < width; x++) {
  const black = isBlack(x);
  
  if (currentState === 0 && !black) {
    if (x === 20 || x === 25 || x === 30 || x === 55) console.log(`x=${x} initial ignore`);
    continue;
  }

  if ((currentState % 2 === 0 && black) || (currentState % 2 === 1 && !black)) {
    stateCounts[currentState]++;
  } else {
    console.log(`x=${x} State switch. Current state: ${currentState}, counts: ${stateCounts}`);
    if (currentState === 4) {
      console.log(`x=${x}, checking ratio:`, stateCounts);
      if (checkRatio(stateCounts)) {
        centers.push(x);
        currentState = 0;
        stateCounts = [0, 0, 0, 0, 0];
      } else {
        stateCounts[0] = stateCounts[2];
        stateCounts[1] = stateCounts[3];
        stateCounts[2] = stateCounts[4];
        stateCounts[3] = 1;
        stateCounts[4] = 0;
        currentState = 3;
      }
    } else {
      currentState++;
      stateCounts[currentState] = 1;
    }
  }
}
console.log("Centers:", centers);
console.log("State at end:", stateCounts, currentState);
