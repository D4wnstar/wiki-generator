import { Vault } from "obsidian"
import initSqlJs, { Database } from "sql.js"
import { findFileInPlugin } from "./filesystem"
import { runMigrations } from "./operations"

export async function initializeSqliteClient(vault: Vault): Promise<Database> {
	const db = await createSqliteDatabase(vault)
	runMigrations(db)
	return db
}

async function createSqliteDatabase(vault: Vault): Promise<Database> {
	const SQL = await initSqlJs({
		locateFile: (_file) => findFileInPlugin(vault, "sql-wasm.wasm", true),
	})

	return new SQL.Database()
}
