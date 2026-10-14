import { Capacitor } from '@capacitor/core';
import { createWebApi } from './web.js';
import { createAndroidApi } from './android.js';

/**
 * Data/trading API for the UI. In the browser it talks to the Node backend;
 * in the Android app (Capacitor) everything runs on the phone.
 */
export const isNativeApp = Capacitor.isNativePlatform();
export const api = isNativeApp ? createAndroidApi() : createWebApi();
