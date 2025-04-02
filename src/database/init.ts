import { Vault } from "obsidian"
import initSqlJs, { Database } from "sql.js"
import { findFileInPlugin } from "./filesystem"
import * as fs from "fs"

export async function createLocalDatabase(vault: Vault): Promise<Database> {
	const SQL = await initSqlJs({
		locateFile: (_file) => findFileInPlugin(vault, "sql-wasm.wasm", true),
	})

	const existingDbPath = findFileInPlugin(vault, "data.db", true)

	let db: Database
	if (fs.existsSync(existingDbPath)) {
		const dbData = fs.readFileSync(existingDbPath)
		db = new SQL.Database(new Uint8Array(dbData))
	} else {
		db = new SQL.Database()
	}

	// Enable foreign key constraints
	db.run("PRAGMA foreign_keys = ON;")
	return db
}
