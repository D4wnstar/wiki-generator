import { FileManager, MarkdownView, TFile, Workspace } from "obsidian"
import { WikiGeneratorSettings } from "./settings"
import { isFilePublic } from "./utils"

export async function addWikiPublishToNewFile(
	newFile: TFile,
	settings: WikiGeneratorSettings,
	workspace: Workspace,
	fileManager: FileManager
) {
	// Timeout is here to let the workspace update before getting the view
	// Half a second seems to make it play well enough with Templater
	setTimeout(async () => {
		const view = workspace.getActiveViewOfType(MarkdownView)

		// Check that an editor is selected
		if (view) {
			const filepath = view.file?.path

			// If there is no open file or if the current file is not the one
			// that was just created, ignore it
			// This prevents frontmatter being added when a file is created elsewhere
			// such as when dragging and dropping a file or when pulling from GitHub
			// with the Obsidian git plugin
			if (!filepath || filepath !== newFile.path) return

			// Only add frontmatter if folders aren't restricted or we're in a valid folder
			if (isFilePublic(newFile.path, settings)) {
				await fileManager.processFrontMatter(newFile, (matter) => {
					if (matter["excalidraw-plugin"]) return // Bypass Excalidraw files
					matter["wiki-publish"] = true
				})
			}
		}
	}, 500)
}
