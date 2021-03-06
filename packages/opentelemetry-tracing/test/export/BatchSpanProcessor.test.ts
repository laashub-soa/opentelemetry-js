/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { AlwaysOnSampler, ExportResult } from '@opentelemetry/core';
import * as assert from 'assert';
import * as sinon from 'sinon';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  Span,
} from '../../src';
import { context } from '@opentelemetry/api';
import { TestTracingSpanExporter } from './TestTracingSpanExporter';
import { TestStackContextManager } from './TestStackContextManager';

function createSampledSpan(spanName: string): Span {
  const tracer = new BasicTracerProvider({
    sampler: new AlwaysOnSampler(),
  }).getTracer('default');
  const span = tracer.startSpan(spanName);
  span.end();
  return span as Span;
}

describe('BatchSpanProcessor', () => {
  const name = 'span-name';
  const defaultBufferConfig = {
    bufferSize: 5,
    bufferTimeout: 2000,
  };
  let exporter: InMemorySpanExporter;
  beforeEach(() => {
    exporter = new InMemorySpanExporter();
  });
  afterEach(() => {
    exporter.reset();
    sinon.restore();
  });

  describe('constructor', () => {
    it('should create a BatchSpanProcessor instance', () => {
      const processor = new BatchSpanProcessor(exporter);
      assert.ok(processor instanceof BatchSpanProcessor);
      processor.shutdown();
    });

    it('should create a BatchSpanProcessor instance with config', () => {
      const processor = new BatchSpanProcessor(exporter, defaultBufferConfig);
      assert.ok(processor instanceof BatchSpanProcessor);
      processor.shutdown();
    });

    it('should create a BatchSpanProcessor instance with empty config', () => {
      const processor = new BatchSpanProcessor(exporter, {});
      assert.ok(processor instanceof BatchSpanProcessor);
      processor.shutdown();
    });
  });

  describe('.onStart/.onEnd/.shutdown', () => {
    it('should do nothing after processor is shutdown', () => {
      const processor = new BatchSpanProcessor(exporter, defaultBufferConfig);
      const spy: sinon.SinonSpy = sinon.spy(exporter, 'export') as any;

      const span = createSampledSpan(`${name}_0`);

      processor.onEnd(span);
      assert.strictEqual(processor['_finishedSpans'].length, 1);

      processor.forceFlush();
      assert.strictEqual(exporter.getFinishedSpans().length, 1);

      processor.onEnd(span);
      assert.strictEqual(processor['_finishedSpans'].length, 1);

      assert.strictEqual(spy.args.length, 1);
      processor.shutdown();
      assert.strictEqual(spy.args.length, 2);
      assert.strictEqual(exporter.getFinishedSpans().length, 0);

      processor.onEnd(span);
      assert.strictEqual(spy.args.length, 2);
      assert.strictEqual(processor['_finishedSpans'].length, 0);
      assert.strictEqual(exporter.getFinishedSpans().length, 0);
    });

    it('should export the sampled spans with buffer size reached', () => {
      const processor = new BatchSpanProcessor(exporter, defaultBufferConfig);
      for (let i = 0; i < defaultBufferConfig.bufferSize; i++) {
        const span = createSampledSpan(`${name}_${i}`);
        processor.onStart(span);
        assert.strictEqual(exporter.getFinishedSpans().length, 0);

        processor.onEnd(span);
        assert.strictEqual(exporter.getFinishedSpans().length, 0);
      }
      // Now we should start seeing the spans in exporter
      const span = createSampledSpan(`${name}_6`);
      processor.onEnd(span);
      assert.strictEqual(exporter.getFinishedSpans().length, 6);

      processor.shutdown();
      assert.strictEqual(exporter.getFinishedSpans().length, 0);
    });

    it('should force flush when timeout exceeded', done => {
      const clock = sinon.useFakeTimers();
      const processor = new BatchSpanProcessor(exporter, defaultBufferConfig);
      for (let i = 0; i < defaultBufferConfig.bufferSize; i++) {
        const span = createSampledSpan(`${name}_${i}`);
        processor.onEnd(span);
        assert.strictEqual(exporter.getFinishedSpans().length, 0);
      }

      setTimeout(() => {
        assert.strictEqual(exporter.getFinishedSpans().length, 5);
        done();
      }, defaultBufferConfig.bufferTimeout + 1000);

      clock.tick(defaultBufferConfig.bufferTimeout + 1000);

      clock.restore();
    });

    it('should force flush on demand', () => {
      const processor = new BatchSpanProcessor(exporter, defaultBufferConfig);
      for (let i = 0; i < defaultBufferConfig.bufferSize; i++) {
        const span = createSampledSpan(`${name}_${i}`);
        processor.onEnd(span);
      }
      assert.strictEqual(exporter.getFinishedSpans().length, 0);
      processor.forceFlush();
      assert.strictEqual(exporter.getFinishedSpans().length, 5);
    });

    it('should not export empty span lists', done => {
      const spy = sinon.spy(exporter, 'export');
      const clock = sinon.useFakeTimers();

      const tracer = new BasicTracerProvider({
        sampler: new AlwaysOnSampler(),
      }).getTracer('default');
      const processor = new BatchSpanProcessor(exporter, defaultBufferConfig);

      // start but do not end spans
      for (let i = 0; i < defaultBufferConfig.bufferSize; i++) {
        const span = tracer.startSpan('spanName');
        processor.onStart(span as Span);
      }

      setTimeout(() => {
        assert.strictEqual(exporter.getFinishedSpans().length, 0);
        // after the timeout, export should not have been called
        // because no spans are ended
        sinon.assert.notCalled(spy);
        done();
      }, defaultBufferConfig.bufferTimeout + 1000);

      // no spans have been finished
      assert.strictEqual(exporter.getFinishedSpans().length, 0);
      clock.tick(defaultBufferConfig.bufferTimeout + 1000);

      clock.restore();
    });
  });

  describe('force flush', () => {
    describe('no waiting spans', () => {
      it('should call an async callback when flushing is complete', done => {
        const processor = new BatchSpanProcessor(exporter);
        processor.forceFlush(() => {
          done();
        });
      });

      it('should call an async callback when shutdown is complete', done => {
        const processor = new BatchSpanProcessor(exporter);
        processor.shutdown(() => {
          done();
        });
      });
    });

    describe('spans waiting to flush', () => {
      let processor: BatchSpanProcessor;

      beforeEach(() => {
        processor = new BatchSpanProcessor(exporter);
        const span = createSampledSpan('test');
        processor.onStart(span);
        processor.onEnd(span);

        assert.strictEqual(processor['_finishedSpans'].length, 1);
      });

      it('should call an async callback when flushing is complete', done => {
        processor.forceFlush(() => {
          assert.strictEqual(exporter.getFinishedSpans().length, 1);
          done();
        });
      });

      it('should call an async callback when shutdown is complete', done => {
        let exportedSpans = 0;
        sinon.stub(exporter, 'export').callsFake((spans, callback) => {
          setTimeout(() => {
            exportedSpans = exportedSpans + spans.length;
            callback(ExportResult.SUCCESS);
          }, 0);
        });

        processor.shutdown(() => {
          assert.strictEqual(exportedSpans, 1);
          done();
        });
      });
    });

    describe('flushing spans with exporter triggering instrumentation', () => {
      beforeEach(() => {
        const contextManager = new TestStackContextManager().enable();
        context.setGlobalContextManager(contextManager);
      });

      afterEach(() => {
        context.disable();
      });

      it('should prevent instrumentation prior to export', done => {
        const testTracingExporter = new TestTracingSpanExporter();
        const processor = new BatchSpanProcessor(testTracingExporter);

        const span = createSampledSpan('test');
        processor.onStart(span);
        processor.onEnd(span);

        processor.forceFlush(() => {
          const exporterCreatedSpans = testTracingExporter.getExporterCreatedSpans();
          assert.equal(exporterCreatedSpans.length, 0);

          done();
        });
      });
    });
  });
});
