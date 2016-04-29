/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 * <p/>
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

package com.facebook.react.modules.fresco;

import java.io.IOException;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executor;

import android.net.Uri;
import android.os.Looper;
import android.os.SystemClock;

import com.facebook.common.logging.FLog;
import com.facebook.imagepipeline.backends.okhttp3.OkHttpNetworkFetcher;
import com.facebook.imagepipeline.producers.BaseProducerContextCallbacks;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.ReadableMapKeySetIterator;
import okhttp3.CacheControl;
import okhttp3.Callback;
import okhttp3.Call;
import okhttp3.Headers;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

class NetworkFetcher extends OkHttpNetworkFetcher {

  private static final String TAG = "NetworkFetcher";

  private final OkHttpClient mOkHttpClient;
  private final Executor mCancellationExecutor;

  /**
   * @param okHttpClient client to use
   */
  public NetworkFetcher(OkHttpClient okHttpClient) {
    super(okHttpClient);
    mOkHttpClient = okHttpClient;
    mCancellationExecutor = okHttpClient.dispatcher().executorService();
  }

  private Map<String, String> getHeaders(ReadableMap readableMap) {
    if (readableMap == null) {
        return null;
    }
    ReadableMapKeySetIterator iterator = readableMap.keySetIterator();
    Map<String, String> map = new HashMap<>();
    while (iterator.hasNextKey()) {
      String key = iterator.nextKey();
      String value = readableMap.getString(key);
      map.put(key, value);
    }
    return map;
  }

  @Override
  public void fetch(final OkHttpNetworkFetchState fetchState, final Callback callback) {
    fetchState.submitTime = SystemClock.elapsedRealtime();
    final Uri uri = fetchState.getUri();
    Map<String, String> requestHeaders = null;
    if (fetchState.getContext().getImageRequest() instanceof NetworkImageRequest) {
      NetworkImageRequest networkImageRequest = (NetworkImageRequest)
        fetchState.getContext().getImageRequest();
      requestHeaders = getHeaders(networkImageRequest.getHeaders());
    }
    if (requestHeaders == null) {
      requestHeaders = Collections.emptyMap();
    }
    final Request request = new Request.Builder()
      .cacheControl(new CacheControl.Builder().noStore().build())
      .url(uri.toString())
      .headers(Headers.of(requestHeaders))
      .get()
      .build();
    final Call call = mOkHttpClient.newCall(request);

    fetchState.getContext().addCallbacks(
      new BaseProducerContextCallbacks() {
        @Override
        public void onCancellationRequested() {
          if (Looper.myLooper() != Looper.getMainLooper()) {
            call.cancel();
          } else {
            mCancellationExecutor.execute(new Runnable() {
              @Override
              public void run() {
                call.cancel();
              }
            });
          }
        }
      });

    call.enqueue(
      new okhttp3.Callback() {
        @Override
        public void onResponse(Call c, Response response) {
          fetchState.responseTime = SystemClock.elapsedRealtime();
          final ResponseBody body = response.body();
          try {
            long contentLength = body.contentLength();
            if (contentLength < 0) {
              contentLength = 0;
            }
            callback.onResponse(body.byteStream(), (int) contentLength);
          } catch (Exception e) {
            handleException(call, e, callback);
          } finally {
            try {
              body.close();
            } catch (Exception e) {
              FLog.w(TAG, "Exception when closing response body", e);
            }
          }
        }

        @Override
        public void onFailure(final Call c, final IOException e) {
          handleException(call, e, callback);
        }
      });
  }

  /**
   * Handles exceptions.
   *
   * <p> OkHttp notifies callers of cancellations via an IOException. If IOException is caught
   * after request cancellation, then the exception is interpreted as successful cancellation
   * and onCancellation is called. Otherwise onFailure is called.
   */
  private void handleException(final Call call, final Exception e, final Callback callback) {
    if (call.isCanceled()) {
      callback.onCancellation();
    } else {
      callback.onFailure(e);
    }
  }
}
