import {collectionMode} from './collection-config'
import {directOkxMode} from './market-provider'
import {getCollectionStream} from './collection-stream'
import {getOkxSnippetWebSocket} from './okx-snippet-ws'
export const getPublicMarketSocket=()=>collectionMode()&&!directOkxMode()?getCollectionStream():getOkxSnippetWebSocket()
