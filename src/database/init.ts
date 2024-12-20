import { Vault } from "obsidian"
import initSqlJs, { Database } from "sql.js"
import { findFileInPlugin } from "./filesystem"
import { runLocalMigrations } from "./operations"
import { Client, createClient } from "@libsql/client"

async function createLocalDatabase(vault: Vault): Promise<Database> {
	const SQL = await initSqlJs({
		locateFile: (_file) => findFileInPlugin(vault, "sql-wasm.wasm", true),
	})

	return new SQL.Database()
}

export async function initializeLocalDatabase(vault: Vault): Promise<Database> {
	const db = await createLocalDatabase(vault)
	runLocalMigrations(db)
	return db
}

export async function initializeRemoteDatabase(
	url: string,
	authToken: string
): Promise<Client> {
	return createClient({ url, authToken })
}
