// src/state/db.ts imports schema.sql as text (`with { type: "text" }`); Bun embeds it in the
// compiled program.
declare module "*.sql" {
  const text: string;
  export default text;
}
