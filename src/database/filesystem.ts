import { FileSystemAdapter, Vault } from "obsidian"
import { id } from "../../manifest.json"
import { Database } from "sql.js"

export function findFileInPlugin(
	vault: Vault,
	filename: string,
	absolute: boolean
): string {
	const path = [vault.configDir, "plugins", id, filename]
	if (absolute)
		path.unshift((vault.adapter as FileSystemAdapter).getBasePath())
	return path.join("/")
}

export async function exportDb(db: Database, vault: Vault) {
	const buf = db.export()
	await vault.adapter.writeBinary(
		findFileInPlugin(vault, "db/data.db", false),
		buf
	)
}
