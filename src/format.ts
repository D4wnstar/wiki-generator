import { Converter } from "showdown";
import slugify from 'slugify'
import { Vault } from "obsidian";
import { writeFileSync } from "fs";
import { join } from "path";

type Note = {
    title: string
    path: string
    slug: string
    content: string
    references: Set<string>
    backreferences: Backreference[]
}

type Backreference = {
    displayName: string
    slug: string
}

function slugifyPath(path:string): string {
    const elems = path.split("/").filter(elem => elem !== "")
    const slugged = []
    for (const elem of elems) {
        slugged.push(slugify(elem, {lower: true, remove: /[^\w\d\s]/g}))
    }

    return slugged.join("/")
}

function formatMd(md: string): string {
    md = md.replace(/^---\n.*?\n---/g, "") // Remove obsidian properties
    md = md.replace(/^:::hidden\n.*?\n:::/gms, "") // Remove :::hidden::: blocks
    md = md.replace(/^#+ GM.*?(?=^#|$(?![\r\n]))/gms, "") // Remove GM paragraphs
    return md
}

function backrefAlreadyExists(displayName: string, slug: string, backrefs: Backreference[]): boolean {
    for (const backref of backrefs) {
        if (backref.displayName === displayName && backref.slug === slug) {
            return true
        }
    }

    return false
}

function convertWikilinks(note: Note, notes: Note[]): Note {
    note.content = note.content.replace(/\[\[(.*?)(?:\|(.*?)?)?\]\]/g, (match, ...groups) => {
        const captureGroups: string[] = groups.slice(0, -2)
        const realName = captureGroups[0]
        const altName = captureGroups.length > 1 ? captureGroups[1] : undefined
        // Check if the path is explicit (like [[Enciclopedia Antediluviana/Nazioni/Auriga]])
        // or implicit (like [[Auriga]]). If it's implicit, the note name is unique.
        const refNote = realName.split("/").filter(elem => elem !== "").length > 1
                        ? notes.find((note) => note.slug === slugifyPath(realName))
                        : notes.find((note) => note.title.toLowerCase() === realName.toLowerCase())

        if (refNote) {
            if (!backrefAlreadyExists(note.title, note.slug, refNote.backreferences)) {
                refNote.backreferences.push({ displayName: note.title, slug: note.slug })
            }
        }
        else {
            console.warn(`Could not find note "${realName}"`)
            return altName ? altName : realName
        }

        note.references.add(refNote.slug)
        return `<a href="/${refNote.slug}" class="anchor">${altName ? altName : realName}</a>`
    })

    return note
}

async function readNotes(converter: Converter, vault: Vault): Promise<Note[]> {
    const notes = []
    const mdFiles = vault.getMarkdownFiles();

    for (const file of mdFiles) {
        const slug = slugifyPath(file.path.replace(".md", ""))

        let content = await vault.read(file);
        content = formatMd(content)

        let html = converter.makeHtml(content)
        html = html.replace(/<h(\d)(.*?)>(.*?)<\/h\d>/g, '<h$1$2 class="h$1">$3</h$1>')
        html = html.replace(/<blockquote>/g, '<blockquote class="blockquote">')
        html = html.replace(/<ul>/g, '<ul class="list-disc list-inside [&_&]:pl-5">')
        html = html.replace(/<ol>/g, '<ul class="list-decimal list-inside [&_&]:pl-5">')

        notes.push({
            title: file.name.replace(".md", ""),
            path: file.path.replace(".md", ""),
            slug: slug,
            content: html,
            references: new Set<string>(),
            backreferences: [],
        })
    }
    return notes
}


export async function convertNotesForUpload(vault: Vault, outPath: string): Promise<void> {
    const converter = new Converter()
    let notes = await readNotes(converter, vault);
    notes = notes.map((note) => convertWikilinks(note, notes))
    
    let notesJsonString = "export const notes = [\n"
    for (const note of notes) {
        notesJsonString += "\t{"
        notesJsonString += `\n\t\ttitle: "${note.title}",`
        notesJsonString += `\n\t\tpath: "${note.path}",`
        notesJsonString += `\n\t\tslug: "${note.slug}",`
        notesJsonString += `\n\t\treferences: [`
        for (const ref of note.references) {
            notesJsonString += `"${ref}", `
        }
        notesJsonString += `],`
        notesJsonString += `\n\t\tbackreferences: [`
        for (const ref of note.backreferences) {
            notesJsonString += `{displayName: "${ref.displayName}", slug: "${ref.slug}"}, `
        }
        notesJsonString += `],`
        notesJsonString += `\n\t\tcontent: \`${note.content}\`,`
        notesJsonString += "\n\t},\n"
    }
    notesJsonString += "]"
    
    writeFileSync(join(outPath, "notes-data.ts"), notesJsonString, { encoding: "utf-8" })
}

export function sayMyName() {
    console.log(__dirname)
}