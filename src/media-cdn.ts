import { createSign } from 'node:crypto'

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'

// Pictures and videos on forum posts are served by a CloudFront distribution in front of the private materials bucket
// (Origin Access Control; accs-architecture api.yaml, MediaDistribution). The API checks that the viewer can read the
// post, then hands out a CloudFront signed URL with a canned policy. The private key lives in an SSM SecureString and is
// read once per Lambda instance; it is never logged or returned.

/** Picture links last as long as S3 signed links; a video link must outlive one viewing, since seeking re-requests it. */
export const mediaPictureUrlSeconds = 300
export const mediaVideoUrlSeconds = 3600

/** CloudFront's URL-safe base64: + becomes -, = becomes _, / becomes ~. */
const cloudFrontBase64 = (value: Buffer) => value.toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~')

/** A CloudFront signed URL with a canned policy: the URL works until `expiresAt` (epoch seconds), for anyone holding it. */
export function signCloudFrontUrl(url: string, keyPairId: string, privateKey: string, expiresAt: number) {
  const policy = JSON.stringify({ Statement: [{ Resource: url, Condition: { DateLessThan: { 'AWS:EpochTime': expiresAt } } }] })
  const signature = cloudFrontBase64(createSign('RSA-SHA1').update(policy).sign(privateKey))
  return `${url}${url.includes('?') ? '&' : '?'}Expires=${expiresAt}&Signature=${signature}&Key-Pair-Id=${keyPairId}`
}

export interface MediaSigner {
  /** A signed CloudFront link to a stored object (a key under materials/posts/), valid for `seconds`. */
  url(key: string, seconds: number): Promise<string>
}

/** Signs links for `domain` (no scheme) with the key in `loadKey`, fetched on first use and then kept for the instance. */
export function createMediaSigner(domain: string, keyPairId: string, loadKey: () => Promise<string>, now = () => Date.now()): MediaSigner {
  let key: Promise<string> | undefined
  return {
    async url(objectKey, seconds) {
      // A failed fetch is not kept, so the next request tries again.
      key ??= loadKey().catch((error) => { key = undefined; throw error })
      const path = objectKey.split('/').map(encodeURIComponent).join('/')
      return signCloudFrontUrl(`https://${domain}/${path}`, keyPairId, await key, Math.floor(now() / 1000) + seconds)
    },
  }
}

/** Reads the signing key from an SSM SecureString parameter. */
export const ssmPrivateKey = (name: string, ssm = new SSMClient({})) => async () => {
  const found = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))
  if (!found.Parameter?.Value) throw new Error('Media signing key parameter is empty')
  return found.Parameter.Value
}
