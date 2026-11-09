// Internal notes retain their real staff actor but are not sent to customers.
export const isServiceStaffReply=message=>message?.authorType==='staff'&&message.sourceMetadata?.nativeContent?.kind!=='reaction'&&message.internalNote!==true&&message.sourceMetadata?.nativeEvent?.kind!=='internal_note';
