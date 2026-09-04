// Run in a Tessera terminal: node scripts/sixel-demo.mjs
const escape = "\x1b";
const band = "#1!64~#2!64~#3!64~";
process.stdout.write(`${escape}[2J${escape}[HTessera Sixel: red, green, blue\r\n`);
process.stdout.write(`${escape}Pq"1;1;192;96#1;2;100;0;0#2;2;0;100;0#3;2;0;0;100${Array(16).fill(band).join("-")}${escape}\\\r\nText after the image.\r\n`);
