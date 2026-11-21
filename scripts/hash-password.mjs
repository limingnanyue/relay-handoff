import { hashPassword } from '../server/security.mjs'

const password = process.env.RELAY_NEW_ACCOUNT_PASSWORD
if (!password) throw new Error('请通过临时环境变量 RELAY_NEW_ACCOUNT_PASSWORD 提供口令。')
console.log(await hashPassword(password))
