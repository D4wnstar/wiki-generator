import { Vault } from "obsidian"
import initSqlJs, { Database } from "sql.js"
import { findFileInPlugin } from "./filesystem"
import * as fs from "fs"
import { WikiGeneratorSettings } from "src/settings"
import { LocalDatabaseAdapter, RemoteDatabaseAdapter } from "./operations"
import { createClient } from "@libsql/client/."

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

export async function initializeAdapter(
	settings: WikiGeneratorSettings,
	vault: Vault
) {
	if (settings.localExport) {
		return new LocalDatabaseAdapter(await createLocalDatabase(vault))
	} else {
		return new RemoteDatabaseAdapter(
			createClient({
				url: settings.dbUrl,
				authToken: settings.dbToken,
			})
		)
	}
}
