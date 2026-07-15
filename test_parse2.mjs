import { parseMessage } from './worker/src/parser.js';

// Test with Kerala group name
const text = "Bc 23=5set.. Bc 60=5set.. Bc 96=5set. Bc 53=5set.. Bc 45=5set..";
const result = parseMessage(text, "Bala 494 kerala - Prem", "919894049974-1577513975@g.us", "TEST123", Date.now()/1000, "sender", "Tester");

console.log("Lottery:", result.lottery);
console.log("Timeslot:", result.timeslot);
console.log("Entries:", result.entries.length);
for (const e of result.entries) {
  console.log(`  number=${e.number} betType=${e.betType} qty=${e.qty} rate=${e.rate}`);
}
