import { readdir, readFile } from "node:fs/promises";

const artworkFiles = (await readdir("public/artwork")).filter((file) => file.endsWith(".svg"));
if (artworkFiles.length !== 120) throw new Error(`Expected 120 SVGs, found ${artworkFiles.length}`);

const source = await readFile("src/data/fixtures.generated.ts", "utf8");
const records = source.match(/"id": "frame-/g) ?? [];
const paths = new Set(source.match(/\/artwork\/frame-\d{3}\.svg/g) ?? []);
if (records.length !== 120 || paths.size !== 120) throw new Error("Fixture record/path invariant failed");
if (/"artworkSrc": "https?:/.test(source)) throw new Error("Remote artwork dependency found");

console.log("Fixture corpus checks passed: 120 records and 120 bundled SVGs.");
