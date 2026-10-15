import { app } from './app.js'
import { env } from './env.js'

app.listen(env.PORT, () => {
  console.log(`API listening on :${env.PORT}`)
})
