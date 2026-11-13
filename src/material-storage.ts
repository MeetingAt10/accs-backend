import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// Class material files (#44, decided 12 November 2026: up to 25 MB; PDF, Word, PowerPoint, Excel, plain text, PNG, JPG).
// Files never pass through the API: the browser uploads to S3 with a short-lived signed PUT, and downloads go through a
// short-lived signed GET after the API checks access. The bucket is private (accs-architecture, MATERIALS_BUCKET).

export const materialMaxBytes = 25 * 1024 * 1024
/** Allowed content types and the file extensions each may carry. */
export const materialFileTypes: Readonly<Record<string, readonly string[]>> = {
  'application/pdf': ['pdf'],
  'application/msword': ['doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.ms-powerpoint': ['ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'text/plain': ['txt'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
}
export const uploadUrlSeconds = 600
export const downloadUrlSeconds = 300

export interface MaterialStorage {
  /** A signed PUT that only accepts this exact content type and size. */
  uploadUrl(key: string, contentType: string, size: number): Promise<string>
  /** A signed GET that downloads the file under its original name. */
  downloadUrl(key: string, fileName: string): Promise<string>
  /** The stored object's size and type, or undefined when nothing was uploaded. */
  head(key: string): Promise<{ size: number; contentType?: string } | undefined>
  remove(key: string): Promise<void>
}

/** A file name safe for a storage key and a download header: letters, digits, dot, dash and underscore. */
export const safeFileName = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-100) || 'file'

export function createS3MaterialStorage(bucket: string, s3: S3Client = new S3Client({})): MaterialStorage {
  return {
    uploadUrl: (key, contentType, size) => getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: size }), { expiresIn: uploadUrlSeconds, signableHeaders: new Set(['content-type', 'content-length']) }),
    downloadUrl: (key, fileName) => getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: `attachment; filename="${safeFileName(fileName)}"` }), { expiresIn: downloadUrlSeconds }),
    async head(key) {
      try {
        const object = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        return { size: object.ContentLength ?? 0, contentType: object.ContentType }
      } catch (error) {
        if (error instanceof Error && (error.name === 'NotFound' || error.name === 'NoSuchKey')) return undefined
        throw error
      }
    },
    async remove(key) { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })) },
  }
}

/** In memory, for local runs and tests: `put` stands in for the browser's upload. */
export function createMemoryMaterialStorage() {
  const objects = new Map<string, { size: number; contentType: string }>()
  return {
    objects,
    put(key: string, size: number, contentType: string) { objects.set(key, { size, contentType }) },
    async uploadUrl(key: string) { return `memory://upload/${key}` },
    async downloadUrl(key: string, fileName: string) { return `memory://download/${key}?name=${safeFileName(fileName)}` },
    async head(key: string) { return objects.get(key) },
    async remove(key: string) { objects.delete(key) },
  } satisfies MaterialStorage & { objects: Map<string, unknown>; put(key: string, size: number, contentType: string): void }
}
