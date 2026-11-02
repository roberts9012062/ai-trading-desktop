import {mergeConfig} from 'vite'
import base from '../vite.config'
export default mergeConfig(base,{build:{outDir:'.local-data/account-ui-dist',rollupOptions:{input:'scripts/standalone-account-preview.html'}}})
