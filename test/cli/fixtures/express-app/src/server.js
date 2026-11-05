const express = require('express')
const app = express()

// The health route answers a constant, so a probe of it proves liveness only.
app.get('/healthz', (req, res) => {
  res.json({ ok: true })
})

// The payment webhook must keep arriving: silence is the failure.
app.post('/webhooks/stripe', (req, res) => {
  res.json({ received: true })
})

const port = process.env.PORT || 3000
app.listen(port, () => console.log(`listening on ${port}`))
