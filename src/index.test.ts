import crypto from 'crypto'

beforeAll(() => {
  vi.stubGlobal('crypto', crypto)
})

describe('openai-ads-measurement', () => {
  it('provides a generation baseline', () => {
    expect(true).toEqual(true)
  })
})
