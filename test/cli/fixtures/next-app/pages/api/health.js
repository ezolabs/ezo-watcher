export default function handler(req, res) {
  // The handler answers a literal; the dependency state is not in the body.
  res.status(200).json({ status: 'ok' })
}
