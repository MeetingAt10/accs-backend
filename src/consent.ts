// What a student agrees to, word for word. The server stamps the exact text into the record it keeps, so the wording is
// the auditable part: change any sentence and `version` has to change with it. Plain language, because students read
// this before they send a concern or choose how to talk about it. Pages 19 and 20 hand it to the app as `consentWording`.
export const consentWording = {
  version: '2026-11-05',
  report: 'I have read my statement and I want to send it. My adviser can read it so they can help me. I choose whether my Program Chair or the Dean can read it too. If my statement is about my adviser, my adviser is not told about it and cannot read it. It goes to my Program Chair instead. ACCS keeps a record of this agreement with the date and time.',
  talk: {
    chat: 'I agree to talk about my statement in a written chat in ACCS with the office handling it. Only that office and I can read and write in this chat.',
    video: 'I agree to talk about my statement in a video call. The office handling it will add a meeting link and a time. They will see me on the call, so they will know who I am.',
    voice: 'I agree to talk about my statement in a voice call. The office handling it will add a meeting link and a time. They will hear me on the call, so they may know who I am.',
    face_to_face: 'I agree to meet in person to talk about my statement. The office handling it will add a time and a place. They will see me, so they will know who I am.',
  },
  // Added after the sentence of a video or voice call. Recording is off unless the student says yes.
  recording: {
    allow: 'I allow this call to be recorded.',
    deny: 'I do not allow this call to be recorded.',
  },
} as const
