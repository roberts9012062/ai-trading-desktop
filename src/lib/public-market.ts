import {collectionMode} from './collection-config'
import {getCollectionStream} from './collection-stream'
import {getOkxSnippetWebSocket} from './okx-snippet-ws'
export const getPublicMarketSocket=()=>collectionMode()?getCollectionStream():getOkxSnippetWebSocket()
