// [fork] Test helper: (re)create the box sample tables from their migrations.
import boxSamples from "../../../migrations/0006_box_samples.sql?raw";
import hostMemInUse from "../../../migrations/0007_host_mem_in_use.sql?raw";

export type BoxTable =
  "inference_samples" | "host_samples" | "throughput_rollups";

/** One statement per entry, comments and newlines removed (exec needs one per line). */
const STATEMENTS = [boxSamples, hostMemInUse]
  .join(";")
  .split(";")
  .map((s) => s.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim())
  .filter((s) => s.length > 0);

/** Drop `tables` and recreate them with every later column migration applied. */
export async function createBoxTables(
  db: D1Database,
  tables: BoxTable[],
): Promise<void> {
  for (const table of tables) {
    await db.exec(`DROP TABLE IF EXISTS ${table}`);
    for (const statement of STATEMENTS) {
      if (
        statement.startsWith(`CREATE TABLE ${table} `) ||
        statement.startsWith(`ALTER TABLE ${table} `)
      ) {
        await db.exec(statement);
      }
    }
  }
}
