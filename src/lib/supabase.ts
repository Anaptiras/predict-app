import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {createClient} from '@supabase/supabase-js';
const url=process.env.EXPO_PUBLIC_SUPABASE_URL??'';
const key=process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY??'';
export const isSupabaseConfigured=Boolean(url&&key&&!url.includes('YOUR_PROJECT'));
export const supabase=createClient(url||'https://placeholder.supabase.co',key||'placeholder',{auth:{storage:AsyncStorage,autoRefreshToken:true,persistSession:true,detectSessionInUrl:false}});
