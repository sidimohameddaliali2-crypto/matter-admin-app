import mongoose from 'mongoose';

const eventSchema = new mongoose.Schema(
  {
    eventName: {
      type: String,
      required: [true, 'Event name is required'],
      trim: true
    },
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    companyName: {
      type: String,
      required: true
    },
    companyLogo: {
      type: String,
      default: null
    },
    eventDate: {
      type: Date,
      required: [true, 'Event date is required']
    },
    emirate: {
      type: String,
      enum: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'],
      required: [true, 'Emirate is required']
    },
    venue: {
      type: {
        type: String,
        // The event form's Add Venue action supports custom company venue names.
        trim: true,
        required: true
      },
      address: {
        type: String,
        required: [true, 'Address is required']
      },
      area: {
        type: String,
        default: ''
      },
      googleMapsLink: {
        type: String,
        default: null
      },
      latitude: Number,
      longitude: Number
    },
    arrivalTime: {
      type: String, // HH:mm format (e.g., "15:00" for 3pm)
      required: [true, 'Arrival time is required']
    },
    pointOfContact: {
      noPointOfContact: {
        type: Boolean,
        default: false
      },
      name: {
        type: String,
        default: ''
      },
      phone: {
        type: String,
        default: ''
      },
      email: {
        type: String,
        default: ''
      }
    },
    flowerCollection: {
      shopLocation: {
        type: String,
        default: ''
      },
      flowerCount: {
        type: Number,
        default: 1
      },
      pictureUrl: {
        type: String,
        default: ''
      }
    },
    logistics: {
      noLogisticsNeeded: {
        type: Boolean,
        default: false
      },
      numberOfPeople: {
        type: Number,
        default: 1
      },
      staffNames: [String], // Names of staff attending
      specialRequests: {
        type: String,
        default: ''
      },
      equipment: [
        {
          name: String,
          dimensions: String,
          description: String,
          quantity: Number
        }
      ],
      assetsUsed: [
        {
          assetId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'YellowblockAsset'
          },
          itemType: String,
          unit: String,
          material: String,
          unitPrice: Number,
          quantityUsed: Number,
          totalPrice: Number,
          placeOfStorage: String,
          imageUrl: String
        }
      ],
      assetsCheckedOut: {
        type: Boolean,
        default: false
      },
      food: [
        {
          name: String,
          quantity: Number,
          description: String
        }
      ]
    },
    disassembly: {
      isRequired: {
        type: Boolean,
        default: false
      },
      date: Date,
      arrivalTime: String,
      disassemblyTime: String,
      notes: String
    },
    // Whose driver handles a Yellow Block event: their own ('yellow_block', the
    // default and the only behaviour before this field existed) or a Matter
    // driver ('matter'). Only meaningful when companyName is 'Yellow Block'.
    driverProvider: {
      type: String,
      enum: ['yellow_block', 'matter'],
      default: 'yellow_block'
    },
    assignedDriver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    driverName: {
      type: String,
      default: null
    },
    status: {
      type: String,
      enum: ['pending', 'assigned', 'in_progress', 'completed', 'cancelled'],
      default: 'pending'
    },
    notes: {
      type: String,
      default: ''
    },
    isPaid: {
      type: Boolean,
      default: false
    },
    attachments: [
      {
        url: String,
        fileName: String,
        uploadedAt: { type: Date, default: Date.now }
      }
    ]
  },
  { timestamps: true }
);

export default mongoose.model('Event', eventSchema);
