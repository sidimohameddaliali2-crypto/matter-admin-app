// Frankfurt Fluid pricing: active CPU $0.184/hour, memory $0.0152/GB-hour.
// This remains a conservative local estimate, not the provider's invoice.
export function readerComputeMicros({elapsedMs,cpuMicros}){
 if(!Number.isSafeInteger(elapsedMs)||elapsedMs<0||elapsedMs>300_000||!Number.isSafeInteger(cpuMicros)||cpuMicros<0||cpuMicros>elapsedMs*2000+1_000_000)throw Error('Uncertain reader compute measurement');
 // Include 1 CPU-second and 10 wall-seconds for final accounting/response work,
 // plus 25 micros for invocation, request and telemetry overhead. Process CPU
 // overlaps can overcount concurrent requests; never divide that measurement.
 return Math.ceil((cpuMicros+1_000_000)*184_000/3_600_000_000+(elapsedMs+10_000)*4*15_200/3_600_000+25);
}
