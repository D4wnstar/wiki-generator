import { Backreference, Note, slugifyPath } from "./format"

function backrefAlreadyExists(displayName: string, slug: string, backrefs: Backreference[]): boolean {
    for (const backref of backrefs) {
        if (backref.displayName === displayName && backref.slug === slug) {
            return true
        }
    }

    return false
}


export function convertWikilinks(note: Note, notes: Note[]): Note {
    // Note references are changed to <a> tags
    // File references are removed, leaving just the filename
    // Note transclusions copypaste the transcluded text in a <blockquote>
    // File transclusions inject the file in a tag dependent on the file type
    note.content = note.content.replace(/(!)?\[\[(.*?)(?:\|(.*?)?)?\]\]/g, (match, ...groups) => {
        const captureGroups: string[] = groups.slice(0, -2)
        const isTransclusion = captureGroups[0] ? true : false
        const isExternalFile = captureGroups[1].match(/\.*$/) ? true : false
        if (isTransclusion && isExternalFile) {
            handleFileTransclusion()
        } else if (isTransclusion && !isExternalFile) {
            handleNoteTransclusion()
        } else if (!isTransclusion && isExternalFile) {
            handleFileReference()
        } else if (!isTransclusion && !isExternalFile) {
            handleNoteReference()
        }
        const realName = captureGroups[1]
        const altName = captureGroups[2] // may be undefined
        console.log(isTransclusion, realName, altName)
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
            // console.warn(`Could not find note "${realName}"`)
            return altName ? altName : realName
        }

        note.references.add(refNote.slug)
        return `<a href="/${refNote.slug}" class="anchor">${altName ? altName : realName}</a>`
    })

    return note
}