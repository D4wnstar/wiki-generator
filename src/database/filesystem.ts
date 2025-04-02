import { FileSystemAdapter, Vault } from "obsidian"
import { id } from "../../manifest.json"

/**
 * Get the full path to a file in the plugin folder.
 * @param vault A reference to the vault
 * @param filename The file to search
 * @param absolute Whether the returned filepath is absolute or relative to the vault root
 * @returns The path of the searched file
 */
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
