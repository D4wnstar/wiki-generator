import { SupabaseClient, createClient } from "@supabase/supabase-js";
import { WikiGeneratorSettings } from "main";
import { TFile, TFolder, Vault, normalizePath } from "obsidian";

export function resolveTFolder(folderPath: string, vault: Vault) {
    const folderPathNorm = normalizePath(folderPath)
    const folder = vault.getAbstractFileByPath(folderPathNorm)

    if (folder instanceof TFolder) {
        return folder
    } else {
        throw new Error(`Could not find folder with path ${folderPathNorm}. Found ${folder}`)
    }
}

export function getFilesFromFolders(vault: Vault, folders: string[] | string) {
    const files: TFile[] = []
    if (folders instanceof String) {
        folders = <string[]>[folders]
    }
    for (const folder of folders) {
        const folderObj = resolveTFolder(folder, vault)
        Vault.recurseChildren(folderObj, (file) => {
            if (file instanceof TFile) files.push(file)
        })
    }

    return files
}

export function getPublishableFiles(vault: Vault, settings: WikiGeneratorSettings) {
    let notes: TFile[]
    if (settings.restrictFolders) {
        notes = getFilesFromFolders(vault, settings.publishedFolders)
    } else {
        notes = vault.getMarkdownFiles()
    }

    return notes
}

export function createClientWrapper(settings: WikiGeneratorSettings) {
	let client: SupabaseClient

	if (
		settings.supabaseUseLocal &&
		settings.supabaseUrlLocal &&
		settings.supabaseServiceKeyLocal
	) {
		client = createClient(
			settings.supabaseUrlLocal,
			settings.supabaseServiceKeyLocal
		)
	} else if (settings.supabaseUrl && settings.supabaseServiceKey) {
		client = createClient(settings.supabaseUrl, settings.supabaseServiceKey)
	} else {
		throw new Error(
			"Please set both the URL and Service Key for Supabase in the settings"
		)
	}

	return client
}