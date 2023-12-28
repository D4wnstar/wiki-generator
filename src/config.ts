class UploadConfig {
    overwriteFiles = false
}

class StoredMedia {
    files: string[] = []
}

export const uploadConfig = new UploadConfig()

/**
 * This global variable exists to keep track of what files have been uploaded to Supabase Storage.
 * The non-global alternative is requesting a list of files everytime you need to check, however
 * there are two issues:
 * 1) that's a lot of unnecessary API calls
 * 2) it causes issues due to asynchronicity. Since many operations in this plugin are async, it's very
 *    very easy for a new request to be sent before the previous upload has finished, which means it's not
 *    going to be shown in the list of uploaded media. This causes bugs that are hard to track down. Thus,
 *    this plugin keeps track of uploaded file locally in this variable, which is synchronous and instant
 */
export const storedMedia = new StoredMedia()